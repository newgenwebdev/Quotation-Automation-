/**
 * PRICE LIST AND DEFAULT PAYMENT TERMS (Settings)
 *
 * Saving a price creates a NEW VERSION and puts it in use immediately; the previous version is
 * retired. Old versions are never edited (the database refuses), so a quotation always keeps
 * pointing at the exact price it used. There is no separate approval step any more.
 * Every change is written to the audit log in the same transaction.
 */
import { z } from "zod";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { catalogueItems, commercialPolicies, type CatalogueItem, type CommercialPolicy } from "@/db/schema";
import { assertCan, type Actor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";

export class CatalogueError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const textList = z.array(z.string().trim().min(1)).default([]);

export const CatalogueInput = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,40}$/, "Code: use capitals, digits and dashes, e.g. WEB-TEMPLATE"),
  name: z.string().trim().min(2, "Enter the service name"),
  category: z.enum(["website", "landing_page", "ecommerce", "mobile_app", "custom_software", "ai_automation", "seo", "hosting", "maintenance", "other"]),
  kind: z.enum(["package", "add_on"]).default("package"),
  currency: z.string().regex(/^[A-Z]{3}$/).default("MYR"),
  pricingModel: z.enum(["fixed", "per_unit", "base_plus_units"]),
  priceSen: z.number().int().nonnegative(),
  includedUnits: z.number().int().positive().nullable().default(null),
  extraUnitPriceSen: z.number().int().nonnegative().nullable().default(null),
  unitLabel: z.string().trim().min(1).max(20).regex(/[a-z]/i, "Unit name must be a word, e.g. page or month").nullable().default(null),
  minQuantity: z.number().int().positive().default(1),
  maxQuantity: z.number().int().positive().nullable().default(null),
  inclusions: textList,
  exclusions: textList,
  revisionLimit: z.number().int().nonnegative().nullable().default(null),
  technicalReviewConditions: textList,
  alwaysRequiresTechnicalReview: z.boolean().default(false),
  validFrom: isoDate,
  validTo: isoDate.nullable().default(null),
  notes: z.string().nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.pricingModel === "fixed" && (v.minQuantity !== 1 || v.maxQuantity !== 1)) {
    ctx.addIssue({ code: "custom", message: "Fixed-price items must have min and max quantity of 1", path: ["maxQuantity"] });
  }
  if (v.pricingModel !== "fixed" && !v.unitLabel) {
    ctx.addIssue({ code: "custom", message: "Enter the unit name (e.g. page, month, day)", path: ["unitLabel"] });
  }
  if (v.pricingModel === "base_plus_units" && (v.includedUnits === null || v.extraUnitPriceSen === null)) {
    ctx.addIssue({ code: "custom", message: "Base + units pricing needs the units included and an extra-unit price", path: ["includedUnits"] });
  }
  if (v.maxQuantity !== null && v.maxQuantity < v.minQuantity) {
    ctx.addIssue({ code: "custom", message: "Max quantity cannot be below min quantity", path: ["maxQuantity"] });
  }
  if (v.validTo !== null && v.validTo < v.validFrom) {
    ctx.addIssue({ code: "custom", message: "Valid-to date is before valid-from", path: ["validTo"] });
  }
});
export type CatalogueInput = z.input<typeof CatalogueInput>;

/** Save a price: a new version, in use immediately. The previous version of the same code is retired. */
export async function saveCatalogueItem(db: DB, actor: Actor, raw: CatalogueInput, reason?: string): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.manage");
  const input = CatalogueInput.parse(raw);
  return db.transaction(async (tx) => {
    // Lock this code so two people can't create the same version number at once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"catalogue:" + input.code}))`);
    const [{ v }] = await tx.select({ v: max(catalogueItems.version) }).from(catalogueItems).where(eq(catalogueItems.code, input.code));
    const [previous] = await tx.select().from(catalogueItems)
      .where(and(eq(catalogueItems.code, input.code), eq(catalogueItems.status, "approved"))).for("update");
    if (previous) {
      const [retired] = await tx.update(catalogueItems).set({ status: "retired" }).where(eq(catalogueItems.id, previous.id)).returning();
      await writeAudit(tx, actor, { action: "catalogue.retired", entityType: "catalogue_item", entityId: previous.id, before: previous, after: retired, reason: `Replaced by version ${(v ?? 0) + 1}` });
    }
    const [row] = await tx.insert(catalogueItems).values({
      ...input, version: (v ?? 0) + 1, status: "approved", createdBy: actor.id,
      approvedBy: actor.id, approvedAt: new Date(), supersedesId: previous?.id ?? null,
    }).returning();
    await writeAudit(tx, actor, { action: "catalogue.saved", entityType: "catalogue_item", entityId: row.id, before: previous ?? null, after: row, reason });
    return row;
  });
}

/** Put an unpublished draft (e.g. from the seed script) into use. */
export async function publishCatalogueDraft(db: DB, actor: Actor, id: string): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.manage");
  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(catalogueItems).where(eq(catalogueItems.id, id)).for("update");
    if (!draft) throw new CatalogueError("NOT_FOUND", "Price-list item not found.");
    if (draft.status !== "draft") throw new CatalogueError("NOT_DRAFT", "Only unpublished drafts can be published.");
    const [previous] = await tx.select().from(catalogueItems)
      .where(and(eq(catalogueItems.code, draft.code), eq(catalogueItems.status, "approved"))).for("update");
    if (previous) {
      const [retired] = await tx.update(catalogueItems).set({ status: "retired" }).where(eq(catalogueItems.id, previous.id)).returning();
      await writeAudit(tx, actor, { action: "catalogue.retired", entityType: "catalogue_item", entityId: previous.id, before: previous, after: retired, reason: `Replaced by version ${draft.version}` });
    }
    const [row] = await tx.update(catalogueItems).set({ status: "approved", approvedBy: actor.id, approvedAt: new Date() })
      .where(eq(catalogueItems.id, id)).returning();
    await writeAudit(tx, actor, { action: "catalogue.published", entityType: "catalogue_item", entityId: id, before: draft, after: row });
    return row;
  });
}

/** Take a service off the price list (e.g. discontinued). Quotations that used it are unaffected. */
export async function retireCatalogueItem(db: DB, actor: Actor, id: string, reason: string): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.manage");
  if (!reason || reason.trim().length < 3) throw new CatalogueError("REASON_REQUIRED", "Give a short reason for removing this service.");
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(catalogueItems).where(eq(catalogueItems.id, id)).for("update");
    if (!item) throw new CatalogueError("NOT_FOUND", "Price-list item not found.");
    if (item.status !== "approved") throw new CatalogueError("NOT_APPROVED", "Only services in use can be removed.");
    const [row] = await tx.update(catalogueItems).set({ status: "retired" }).where(eq(catalogueItems.id, id)).returning();
    await writeAudit(tx, actor, { action: "catalogue.retired", entityType: "catalogue_item", entityId: id, before: item, after: row, reason });
    return row;
  });
}

/** Services in use today. */
export async function activePriceList(db: Pick<DB, "select">, today: string): Promise<CatalogueItem[]> {
  const rows = await db.select().from(catalogueItems).where(eq(catalogueItems.status, "approved"));
  return rows.filter((c) => c.validFrom <= today && (c.validTo === null || c.validTo >= today))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCatalogueByIds(db: Pick<DB, "select">, ids: string[]): Promise<CatalogueItem[]> {
  if (ids.length === 0) return [];
  return db.select().from(catalogueItems).where(inArray(catalogueItems.id, ids));
}

// ---------- Default payment terms, validity and tax ----------

export const PolicyInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).default("MYR"),
  paymentMilestones: z.array(z.object({ label: z.string().trim().min(1).max(100), percentBp: z.number().int().positive() })).min(1, "Add at least one payment"),
  quoteValidityDays: z.number({ message: "Enter how many days a quotation stays valid" }).int().min(1, "Validity must be at least 1 day").max(365, "Validity can't be more than 365 days"),
  taxEnabled: z.boolean().default(false),
  taxLabel: z.string().trim().min(1).max(40).nullable().default(null),
  taxRateBp: z.number().int().min(0).max(10000).nullable().default(null),
  termsText: z.string().nullable().default(null),
  validFrom: isoDate,
  validTo: isoDate.nullable().default(null),
}).superRefine((v, ctx) => {
  const total = v.paymentMilestones.reduce((s, m) => s + m.percentBp, 0);
  if (total !== 10000) ctx.addIssue({ code: "custom", message: `Payments add up to ${total / 100}%. They must add up to exactly 100%.`, path: ["paymentMilestones"] });
  if (v.taxEnabled && (v.taxLabel === null || v.taxRateBp === null)) {
    ctx.addIssue({ code: "custom", message: "Tax needs a name and a rate when switched on", path: ["taxRateBp"] });
  }
});
export type PolicyInput = z.input<typeof PolicyInput>;

/** Save the default payment terms. In use immediately for new quotations; existing quotations keep theirs. */
export async function savePolicy(db: DB, actor: Actor, raw: PolicyInput): Promise<CommercialPolicy> {
  assertCan(actor, "policy.manage");
  const input = PolicyInput.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('policy:DEFAULT'))`);
    const [{ v }] = await tx.select({ v: max(commercialPolicies.version) }).from(commercialPolicies).where(eq(commercialPolicies.code, "DEFAULT"));
    const [previous] = await tx.select().from(commercialPolicies)
      .where(and(eq(commercialPolicies.code, "DEFAULT"), eq(commercialPolicies.status, "approved"))).for("update");
    if (previous) {
      const [retired] = await tx.update(commercialPolicies).set({ status: "retired" }).where(eq(commercialPolicies.id, previous.id)).returning();
      await writeAudit(tx, actor, { action: "policy.retired", entityType: "commercial_policy", entityId: previous.id, before: previous, after: retired, reason: `Replaced by version ${(v ?? 0) + 1}` });
    }
    const [row] = await tx.insert(commercialPolicies).values({
      ...input, taxLabel: input.taxEnabled ? input.taxLabel : null, taxRateBp: input.taxEnabled ? input.taxRateBp : null,
      code: "DEFAULT", version: (v ?? 0) + 1, status: "approved", createdBy: actor.id, approvedBy: actor.id, approvedAt: new Date(),
    }).returning();
    await writeAudit(tx, actor, { action: "policy.saved", entityType: "commercial_policy", entityId: row.id, before: previous ?? null, after: row });
    return row;
  });
}

export async function loadActivePolicy(db: Pick<DB, "select">): Promise<CommercialPolicy | null> {
  const [row] = await db.select().from(commercialPolicies)
    .where(and(eq(commercialPolicies.code, "DEFAULT"), eq(commercialPolicies.status, "approved")));
  return row ?? null;
}
