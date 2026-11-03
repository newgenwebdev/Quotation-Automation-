/**
 * Price list and default payment terms (Settings), against a REAL PostgreSQL test database.
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type DB } from "@/db/client";
import { users, auditLog, catalogueItems, commercialPolicies } from "@/db/schema";
import { PermissionError, type Actor } from "@/auth/permissions";
import {
  saveCatalogueItem, retireCatalogueItem, publishCatalogueDraft, activePriceList, savePolicy, loadActivePolicy, type CatalogueInput,
} from "@/catalogue/service";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for DB tests");
let db: DB; let pool: import("pg").Pool;
let admin: Actor; let admin2: Actor;

const WEBSITE: CatalogueInput = {
  code: "WEB-TEMPLATE", name: "Template Website (TEST)", category: "website", kind: "package",
  pricingModel: "base_plus_units", priceSen: 500_000, includedUnits: 5, extraUnitPriceSen: 50_000,
  unitLabel: "page", minQuantity: 1, maxQuantity: 10, revisionLimit: 2,
  inclusions: ["Up to 5 pages"], exclusions: ["Copywriting"], validFrom: "2026-01-01",
};

async function expectDbError(p: Promise<unknown>, text: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message).includes(text));
}
const actions = async (entityId: string) => (await db.select().from(auditLog).where(eq(auditLog.entityId, entityId)).orderBy(auditLog.id)).map((r) => r.action);

beforeAll(async () => { ({ db, pool } = createDb(url)); await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await db.execute(sql`TRUNCATE audit_log, catalogue_items, commercial_policies, users RESTART IDENTITY CASCADE`);
  const [a, b] = await db.insert(users).values([{ email: "a@t.local", name: "Admin One" }, { email: "b@t.local", name: "Admin Two" }]).returning();
  admin = { id: a.id, role: a.role, email: a.email };
  admin2 = { id: b.id, role: b.role, email: b.email };
});

describe("Price list (single step, no approval)", () => {
  it("a saved price is in use immediately and logged", async () => {
    const row = await saveCatalogueItem(db, admin, WEBSITE);
    expect(row).toMatchObject({ status: "approved", version: 1, approvedBy: admin.id });
    expect(await actions(row.id)).toEqual(["catalogue.saved"]);
    expect((await activePriceList(db, "2026-06-01")).map((i) => i.code)).toEqual(["WEB-TEMPLATE"]);
  });

  it("changing a price creates a new version and retires the old one (history kept)", async () => {
    const v1 = await saveCatalogueItem(db, admin, WEBSITE);
    const v2 = await saveCatalogueItem(db, admin2, { ...WEBSITE, priceSen: 550_000 }, "2027 rates");
    expect(v2.version).toBe(2);
    const [old] = await db.select().from(catalogueItems).where(eq(catalogueItems.id, v1.id));
    expect(old.status).toBe("retired");
    expect(old.priceSen).toBe(500_000);
    const inUse = await db.select().from(catalogueItems).where(and(eq(catalogueItems.code, "WEB-TEMPLATE"), eq(catalogueItems.status, "approved")));
    expect(inUse).toHaveLength(1);
    expect(await actions(v1.id)).toEqual(["catalogue.saved", "catalogue.retired"]);
  });

  it("the database refuses to edit a price that has been used (old versions are frozen)", async () => {
    const row = await saveCatalogueItem(db, admin, WEBSITE);
    await expectDbError(db.update(catalogueItems).set({ priceSen: 1 }).where(eq(catalogueItems.id, row.id)), "FROZEN_ROW");
    await saveCatalogueItem(db, admin, { ...WEBSITE, priceSen: 600_000 });
    await expectDbError(db.update(catalogueItems).set({ name: "x" }).where(eq(catalogueItems.id, row.id)), "FROZEN_ROW");
  });

  it("validates the pricing structure", async () => {
    await expect(saveCatalogueItem(db, admin, { ...WEBSITE, pricingModel: "fixed", maxQuantity: 3 })).rejects.toThrow(/Fixed-price items/);
    await expect(saveCatalogueItem(db, admin, { ...WEBSITE, includedUnits: null })).rejects.toThrow(/units included/);
    await expect(saveCatalogueItem(db, admin, { ...WEBSITE, unitLabel: "20" })).rejects.toThrow(/must be a word/);
    await expect(saveCatalogueItem(db, admin, { ...WEBSITE, pricingModel: "per_unit", unitLabel: null })).rejects.toThrow(/unit name/);
    await expect(saveCatalogueItem(db, admin, { ...WEBSITE, code: "bad code!" })).rejects.toThrow(/Code/);
  });

  it("removing a service needs a reason and takes it off the active list", async () => {
    const row = await saveCatalogueItem(db, admin, WEBSITE);
    await expect(retireCatalogueItem(db, admin, row.id, "")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await retireCatalogueItem(db, admin, row.id, "Discontinued");
    expect(await activePriceList(db, "2026-06-01")).toHaveLength(0);
  });

  it("only lists services valid on the day", async () => {
    await saveCatalogueItem(db, admin, { ...WEBSITE, code: "OLD", validFrom: "2025-01-01", validTo: "2025-12-31" });
    await saveCatalogueItem(db, admin, { ...WEBSITE, code: "FUTURE", validFrom: "2027-01-01" });
    await saveCatalogueItem(db, admin, WEBSITE);
    expect((await activePriceList(db, "2026-06-01")).map((i) => i.code)).toEqual(["WEB-TEMPLATE"]);
  });

  it("a draft (e.g. from the seed script) is unused until put into use", async () => {
    const [draft] = await db.insert(catalogueItems).values({ ...WEBSITE, currency: "MYR", kind: "package", version: 1, status: "draft", createdBy: admin.id, minQuantity: 1 } as never).returning();
    expect(await activePriceList(db, "2026-06-01")).toHaveLength(0);
    await publishCatalogueDraft(db, admin2, draft.id);
    expect((await activePriceList(db, "2026-06-01"))[0].id).toBe(draft.id);
  });

  it("an account still holding an old role can't change prices", async () => {
    await expect(saveCatalogueItem(db, { ...admin, role: "sales" }, WEBSITE)).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("Default payment terms", () => {
  const terms = {
    paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Development", percentBp: 4000 }, { label: "Launch", percentBp: 1000 }],
    quoteValidityDays: 30, validFrom: "2026-01-01",
  };

  it("are in use as soon as they're saved; saving again replaces them", async () => {
    const v1 = await savePolicy(db, admin, terms);
    expect(v1.status).toBe("approved");
    const v2 = await savePolicy(db, admin, { ...terms, quoteValidityDays: 14 });
    expect((await loadActivePolicy(db))?.id).toBe(v2.id);
    const [old] = await db.select().from(commercialPolicies).where(eq(commercialPolicies.id, v1.id));
    expect(old.status).toBe("retired");
  });

  it("payments must add up to exactly 100% and validity must be set", async () => {
    await expect(savePolicy(db, admin, { ...terms, paymentMilestones: [{ label: "Deposit", percentBp: 5000 }] })).rejects.toThrow(/exactly 100%/);
    await expect(savePolicy(db, admin, { ...terms, quoteValidityDays: 0 })).rejects.toThrow(/at least 1 day/);
  });

  it("tax needs a name and a rate when switched on", async () => {
    await expect(savePolicy(db, admin, { ...terms, taxEnabled: true, taxLabel: null, taxRateBp: null })).rejects.toThrow(/Tax needs/);
    const p = await savePolicy(db, admin, { ...terms, taxEnabled: true, taxLabel: "SST", taxRateBp: 800 });
    expect(p).toMatchObject({ taxLabel: "SST", taxRateBp: 800 });
  });
});

describe("Audit log", () => {
  it("is append-only, even directly in the database", async () => {
    const row = await saveCatalogueItem(db, admin, WEBSITE);
    await expectDbError(db.update(auditLog).set({ reason: "tampered" }).where(eq(auditLog.entityId, row.id)), "AUDIT_APPEND_ONLY");
    await expectDbError(db.delete(auditLog).where(eq(auditLog.entityId, row.id)), "AUDIT_APPEND_ONLY");
  });
});
