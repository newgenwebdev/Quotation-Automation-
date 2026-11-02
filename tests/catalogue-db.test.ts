/**
 * Integration tests against a REAL PostgreSQL test database.
 * Requires TEST_DATABASE_URL (see package.json "test" script).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type DB } from "@/db/client";
import { users, auditLog, catalogueItems } from "@/db/schema";
import type { Actor } from "@/auth/permissions";
import { PermissionError } from "@/auth/permissions";
import {
  createCatalogueDraft, updateCatalogueDraft, approveCatalogueItem, retireCatalogueItem,
  createPolicyDraft, approvePolicy, CatalogueError, type CatalogueDraftInput,
} from "@/catalogue/service";
import { priceQuotation } from "@/pricing/service";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for DB tests");

let db: DB;
let pool: import("pg").Pool;
const A: Record<"sales" | "tech" | "fin1" | "fin2" | "admin", Actor> = {} as never;

const WEBSITE: CatalogueDraftInput = {
  code: "WEB-TEMPLATE", name: "Template Website (TEST)", category: "website", kind: "package",
  pricingModel: "base_plus_units", priceSen: 500_000, includedUnits: 5, extraUnitPriceSen: 50_000,
  unitLabel: "page", minQuantity: 1, maxQuantity: 10, revisionLimit: 2,
  inclusions: ["Up to 5 pages"], exclusions: ["Copywriting"], validFrom: "2026-01-01",
};

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}
async function expectDbError(p: Promise<unknown>, text: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => {
    const msg = String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);
    return msg.includes(text);
  });
}
async function auditActions(entityId: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id);
  return rows.map((r) => r.action);
}
async function setupPolicy() {
  const p = await createPolicyDraft(db, A.fin1, {
    paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Completion", percentBp: 5000 }],
    quoteValidityDays: 30, validFrom: "2026-01-01",
  });
  return approvePolicy(db, A.fin2, p.id);
}

beforeAll(async () => {
  ({ db, pool } = createDb(url));
  await migrate(db, { migrationsFolder: "./drizzle" });
});
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await db.execute(sql`TRUNCATE audit_log, catalogue_items, commercial_policies, users RESTART IDENTITY CASCADE`);
  const rows = await db.insert(users).values([
    { email: "sales@test.local", name: "Sales", role: "sales" },
    { email: "tech@test.local", name: "Tech", role: "technical" },
    { email: "fin1@test.local", name: "Finance One", role: "finance" },
    { email: "fin2@test.local", name: "Finance Two", role: "finance" },
    { email: "admin@test.local", name: "Admin", role: "admin" },
  ]).returning();
  const [sales, tech, fin1, fin2, admin] = rows.map((r) => ({ id: r.id, role: r.role, email: r.email }));
  Object.assign(A, { sales, tech, fin1, fin2, admin });
});

describe("Role permissions", () => {
  it("Sales and Technical cannot create or approve prices", async () => {
    await expect(createCatalogueDraft(db, A.sales, WEBSITE)).rejects.toBeInstanceOf(PermissionError);
    await expect(createCatalogueDraft(db, A.tech, WEBSITE)).rejects.toBeInstanceOf(PermissionError);
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    await expect(approveCatalogueItem(db, A.sales, d.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(approveCatalogueItem(db, A.tech, d.id)).rejects.toBeInstanceOf(PermissionError);
  });

  it("four-eyes rule: the drafter cannot approve their own price", async () => {
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    await expectCode(approveCatalogueItem(db, A.fin1, d.id), "SELF_APPROVAL");
    const ok = await approveCatalogueItem(db, A.fin2, d.id, "Checked against Q4 price list");
    expect(ok.status).toBe("approved");
    expect(ok.approvedBy).toBe(A.fin2.id);
  });

  it("self-approval can be switched on deliberately for a one-person finance team", async () => {
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    const ok = await approveCatalogueItem(db, A.fin1, d.id, undefined, { allowSelfApproval: true });
    expect(ok.status).toBe("approved");
  });
});

describe("Price lifecycle and versioning", () => {
  it("drafts are never used for quotes; approved prices are", async () => {
    await setupPolicy();
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    const before = await priceQuotation(db, A.sales, { currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }] });
    expect(before.status).toBe("blocked");
    expect(before.issues[0].code).toBe("PRICE_NOT_APPROVED");

    await approveCatalogueItem(db, A.fin2, d.id);
    const after = await priceQuotation(db, A.sales, { currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 7 }] });
    expect(after.status).toBe("priced");
    expect(after.totalSen).toBe(600_000);
    expect(after.policyVersion).toBe(1);
  });

  it("a price change is a new version; the old one stays in force until the new one is approved", async () => {
    await setupPolicy();
    const v1 = await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    const v2 = await createCatalogueDraft(db, A.fin1, { ...WEBSITE, priceSen: 550_000 });
    expect(v2.version).toBe(2);
    expect(v2.supersedesId).toBe(v1.id);

    const q = { currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }] };
    expect((await priceQuotation(db, A.sales, q)).totalSen).toBe(500_000);

    await approveCatalogueItem(db, A.admin, v2.id, "2027 price increase");
    const r = await priceQuotation(db, A.sales, q);
    expect(r.totalSen).toBe(550_000);
    expect(r.lines[0].catalogueVersion).toBe(2);

    const [old] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, v1.id));
    expect(old.status).toBe("retired");
    expect(await auditActions(v1.id)).toEqual(["catalogue.draft_created", "catalogue.approved", "catalogue.retired"]);
  });

  it("drafts can be edited (audited); approved versions cannot", async () => {
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    const edited = await updateCatalogueDraft(db, A.fin1, d.id, { priceSen: 520_000 }, "Typo fix");
    expect(edited.priceSen).toBe(520_000);
    await approveCatalogueItem(db, A.fin2, d.id);
    await expectCode(updateCatalogueDraft(db, A.fin1, d.id, { priceSen: 1 }), "NOT_DRAFT");
    expect(await auditActions(d.id)).toEqual(["catalogue.draft_created", "catalogue.draft_updated", "catalogue.approved"]);
  });

  it("retiring needs a reason and removes the item from pricing", async () => {
    await setupPolicy();
    const v = await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    await expectCode(retireCatalogueItem(db, A.fin1, v.id, ""), "REASON_REQUIRED");
    await retireCatalogueItem(db, A.fin1, v.id, "Service discontinued");
    const r = await priceQuotation(db, A.sales, { currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }] });
    expect(r.status).toBe("blocked");
  });

  it("two simultaneous drafts get different version numbers", async () => {
    const [a, b] = await Promise.all([
      createCatalogueDraft(db, A.fin1, WEBSITE), createCatalogueDraft(db, A.fin2, WEBSITE),
    ]);
    expect(new Set([a.version, b.version])).toEqual(new Set([1, 2]));
  });

  it("rejects invalid catalogue entries", async () => {
    await expect(createCatalogueDraft(db, A.fin1, { ...WEBSITE, pricingModel: "fixed" })).rejects.toThrow(/Fixed-price/);
    await expect(createCatalogueDraft(db, A.fin1, { ...WEBSITE, includedUnits: null })).rejects.toThrow(/included units/);
    await expect(createCatalogueDraft(db, A.fin1, { ...WEBSITE, priceSen: -1 })).rejects.toThrow();
    await expect(createCatalogueDraft(db, A.fin1, { ...WEBSITE, validTo: "2025-01-01" })).rejects.toThrow(/before valid-from/);
  });
});

describe("Database-level safety nets (even if app code is bypassed)", () => {
  it("refuses direct SQL edits or deletes of an approved price", async () => {
    const v = await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    await expectDbError(db.update(catalogueItems).set({ priceSen: 1 }).where(eq(catalogueItems.id, v.id)), "FROZEN_ROW");
    await expectDbError(db.delete(catalogueItems).where(eq(catalogueItems.id, v.id)), "FROZEN_ROW");
  });

  it("refuses edits or deletes in the audit log", async () => {
    await createCatalogueDraft(db, A.fin1, WEBSITE);
    await expectDbError(db.update(auditLog).set({ reason: "tampered" }), "AUDIT_APPEND_ONLY");
    await expectDbError(db.delete(auditLog), "AUDIT_APPEND_ONLY");
  });

  it("refuses a second approved version of the same code", async () => {
    const v = await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    const d = await createCatalogueDraft(db, A.fin1, WEBSITE);
    await expectDbError(
      db.update(catalogueItems).set({ status: "approved", approvedBy: A.fin2.id, approvedAt: new Date() }).where(eq(catalogueItems.id, d.id)),
      "catalogue_one_approved_per_code",
    );
    expect(v.status).toBe("approved");
  });
});

describe("Discounts through the service use the logged-in role", () => {
  it("Sales is blocked, Finance succeeds", async () => {
    await setupPolicy();
    await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    const q = {
      currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }],
      discount: { type: "percent" as const, value: 1000, reason: "Loyal client" },
    };
    const bySales = await priceQuotation(db, A.sales, q);
    expect(bySales.status).toBe("blocked");
    expect(bySales.issues.map((i) => i.code)).toContain("DISCOUNT_NOT_AUTHORISED");
    const byFinance = await priceQuotation(db, A.fin1, q);
    expect(byFinance.totalSen).toBe(450_000);
  });
});

describe("Commercial policy", () => {
  it("milestones must total 100% and validity must be set before approval", async () => {
    const bad = await createPolicyDraft(db, A.fin1, { paymentMilestones: [{ label: "Deposit", percentBp: 5000 }], quoteValidityDays: 30, validFrom: "2026-01-01" });
    await expectCode(approvePolicy(db, A.fin2, bad.id), "MILESTONES_INVALID");
    const noValidity = await createPolicyDraft(db, A.fin1, { paymentMilestones: [{ label: "Full", percentBp: 10000 }], validFrom: "2026-01-01" });
    await expectCode(approvePolicy(db, A.fin2, noValidity.id), "VALIDITY_MISSING");
    await expect(createPolicyDraft(db, A.fin1, { taxEnabled: true, validFrom: "2026-01-01" })).rejects.toThrow(/Tax needs/);
  });

  it("with no approved policy, nothing can be priced", async () => {
    await approveCatalogueItem(db, A.fin2, (await createCatalogueDraft(db, A.fin1, WEBSITE)).id);
    const r = await priceQuotation(db, A.sales, { currency: "MYR", asOf: "2026-11-02", lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }] });
    expect(r.issues.map((i) => i.code)).toContain("POLICY_MISSING");
  });
});
