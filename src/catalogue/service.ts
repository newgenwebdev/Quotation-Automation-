/**
 * CATALOGUE SERVICE — the finance-controlled price list.
 *
 * Lifecycle of a price:
 *   draft  →  approved  →  retired
 *   - Finance/Admin create a DRAFT (can be edited freely, never used for quotes).
 *   - A DIFFERENT Finance/Admin person APPROVES it (four-eyes rule, configurable).
 *   - Approving a new version automatically RETIRES the previous approved version.
 *   - Approved prices are frozen; the database itself refuses edits.
 * Every step is written to the audit log in the same transaction.
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

export const CatalogueDraftInput = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,40}$/, "Use capitals, digits and dashes, e.g. WEB-TEMPLATE"),
  name: z.string().trim().min(2),
  category: z.enum(["website", "landing_page", "ecommerce", "mobile_app", "custom_software", "ai_automation", "seo", "hosting", "maintenance", "other"]),
  kind: z.enum(["package", "add_on"]),
  currency: z.string().regex(/^[A-Z]{3}$/).default("MYR"),
  pricingModel: z.enum(["fixed", "per_unit", "base_plus_units"]),
  priceSen: z.number().int().nonnegative(),
  includedUnits: z.number().int().positive().nullable().default(null),
  extraUnitPriceSen: z.number().int().nonnegative().nullable().default(null),
  unitLabel: z.string().trim().min(1).nullable().default(null),
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
  if (v.pricingModel === "base_plus_units" && (v.includedUnits === null || v.extraUnitPriceSen === null)) {
    ctx.addIssue({ code: "custom", message: "Base + units pricing needs included units and an extra-unit price", path: ["includedUnits"] });
  }
  if (v.maxQuantity !== null && v.maxQuantity < v.minQuantity) {
    ctx.addIssue({ code: "custom", message: "Max quantity cannot be below min quantity", path: ["maxQuantity"] });
  }
  if (v.validTo !== null && v.validTo < v.validFrom) {
    ctx.addIssue({ code: "custom", message: "Valid-to date is before valid-from", path: ["validTo"] });
  }
});
export type CatalogueDraftInput = z.input<typeof CatalogueDraftInput>;

export interface ServiceOptions {
  allowSelfApproval?: boolean;
}

function selfApprovalAllowed(opts?: ServiceOptions) {
  return opts?.allowSelfApproval ?? process.env.ALLOW_SELF_APPROVAL === "true";
}

/** Create a new DRAFT version of a catalogue item. Version number is assigned automatically. */
export async function createCatalogueDraft(db: DB, actor: Actor, raw: CatalogueDraftInput): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.draft");
  const input = CatalogueDraftInput.parse(raw);

  return db.transaction(async (tx) => {
    // Lock existing versions of this code so two people can't create the same version number.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"catalogue:" + input.code}))`);
    const [{ v }] = await tx.select({ v: max(catalogueItems.version) }).from(catalogueItems).where(eq(catalogueItems.code, input.code));
    const [current] = await tx.select().from(catalogueItems)
      .where(and(eq(catalogueItems.code, input.code), eq(catalogueItems.status, "approved")));

    const [row] = await tx.insert(catalogueItems).values({
      ...input,
      version: (v ?? 0) + 1,
      status: "draft",
      createdBy: actor.id,
      supersedesId: current?.id ?? null,
    }).returning();

    await writeAudit(tx, actor, { action: "catalogue.draft_created", entityType: "catalogue_item", entityId: row.id, after: row });
    return row;
  });
}

/** Edit a DRAFT. Approved or retired versions can never be edited. */
export async function updateCatalogueDraft(
  db: DB, actor: Actor, id: string, patch: Partial<CatalogueDraftInput>, reason?: string,
): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.draft");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(catalogueItems).where(eq(catalogueItems.id, id)).for("update");
    if (!existing) throw new CatalogueError("NOT_FOUND", "Catalogue item not found");
    if (existing.status !== "draft") {
      throw new CatalogueError("NOT_DRAFT", `Version ${existing.version} of ${existing.code} is ${existing.status}; create a new version instead of editing it.`);
    }
    const { id: _i, version: _v, status: _s, createdBy: _c, approvedBy: _a, approvedAt: _at, supersedesId: _sp, createdAt: _ca, ...editable } = existing;
    const merged = CatalogueDraftInput.parse({ ...editable, ...patch, code: existing.code });
    const [row] = await tx.update(catalogueItems).set(merged).where(eq(catalogueItems.id, id)).returning();
    await writeAudit(tx, actor, { action: "catalogue.draft_updated", entityType: "catalogue_item", entityId: id, before: existing, after: row, reason });
    return row;
  });
}

/** Approve a DRAFT. The previous approved version of the same code is retired automatically. */
export async function approveCatalogueItem(
  db: DB, actor: Actor, id: string, reason?: string, opts?: ServiceOptions,
): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.approve");
  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(catalogueItems).where(eq(catalogueItems.id, id)).for("update");
    if (!draft) throw new CatalogueError("NOT_FOUND", "Catalogue item not found");
    if (draft.status !== "draft") throw new CatalogueError("NOT_DRAFT", `Only drafts can be approved (this one is ${draft.status}).`);
    if (draft.createdBy === actor.id && !selfApprovalAllowed(opts)) {
      throw new CatalogueError("SELF_APPROVAL", "The person who drafted a price cannot approve it. Ask another Finance or Admin user.");
    }

    const [previous] = await tx.select().from(catalogueItems)
      .where(and(eq(catalogueItems.code, draft.code), eq(catalogueItems.status, "approved"))).for("update");
    if (previous) {
      const [retired] = await tx.update(catalogueItems).set({ status: "retired" }).where(eq(catalogueItems.id, previous.id)).returning();
      await writeAudit(tx, actor, { action: "catalogue.retired", entityType: "catalogue_item", entityId: previous.id, before: previous, after: retired, reason: `Superseded by version ${draft.version}` });
    }

    const [approved] = await tx.update(catalogueItems)
      .set({ status: "approved", approvedBy: actor.id, approvedAt: new Date() })
      .where(eq(catalogueItems.id, id)).returning();
    await writeAudit(tx, actor, { action: "catalogue.approved", entityType: "catalogue_item", entityId: id, before: draft, after: approved, reason });
    return approved;
  });
}

/** Withdraw an approved price without replacing it (e.g. a discontinued service). */
export async function retireCatalogueItem(db: DB, actor: Actor, id: string, reason: string): Promise<CatalogueItem> {
  assertCan(actor, "catalogue.retire");
  if (!reason || reason.trim().length < 5) throw new CatalogueError("REASON_REQUIRED", "Retiring a price needs a reason.");
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(catalogueItems).where(eq(catalogueItems.id, id)).for("update");
    if (!item) throw new CatalogueError("NOT_FOUND", "Catalogue item not found");
    if (item.status !== "approved") throw new CatalogueError("NOT_APPROVED", "Only approved items can be retired.");
    const [row] = await tx.update(catalogueItems).set({ status: "retired" }).where(eq(catalogueItems.id, id)).returning();
    await writeAudit(tx, actor, { action: "catalogue.retired", entityType: "catalogue_item", entityId: id, before: item, after: row, reason });
    return row;
  });
}

/** Load every version of the given codes, for the pricing engine (which re-checks approval itself). */
export async function loadCatalogueForPricing(db: DB, codes: string[]): Promise<CatalogueItem[]> {
  if (codes.length === 0) return [];
  return db.select().from(catalogueItems).where(inArray(catalogueItems.code, codes));
}

// ---------- Commercial policy (payment terms, validity, tax) ----------

export const PolicyDraftInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).default("MYR"),
  paymentMilestones: z.array(z.object({ label: z.string().trim().min(1), percentBp: z.number().int().positive() })).default([]),
  quoteValidityDays: z.number().int().positive().nullable().default(null),
  taxEnabled: z.boolean().default(false),
  taxLabel: z.string().trim().min(1).nullable().default(null),
  taxRateBp: z.number().int().nonnegative().nullable().default(null),
  termsText: z.string().nullable().default(null),
  validFrom: isoDate,
  validTo: isoDate.nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.taxEnabled && (v.taxLabel === null || v.taxRateBp === null)) {
    ctx.addIssue({ code: "custom", message: "Tax needs a label and a rate when switched on", path: ["taxRateBp"] });
  }
});
export type PolicyDraftInput = z.input<typeof PolicyDraftInput>;

export async function createPolicyDraft(db: DB, actor: Actor, raw: PolicyDraftInput): Promise<CommercialPolicy> {
  assertCan(actor, "policy.draft");
  const input = PolicyDraftInput.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('policy:DEFAULT'))`);
    const [{ v }] = await tx.select({ v: max(commercialPolicies.version) }).from(commercialPolicies).where(eq(commercialPolicies.code, "DEFAULT"));
    const [row] = await tx.insert(commercialPolicies).values({ ...input, code: "DEFAULT", version: (v ?? 0) + 1, createdBy: actor.id }).returning();
    await writeAudit(tx, actor, { action: "policy.draft_created", entityType: "commercial_policy", entityId: row.id, after: row });
    return row;
  });
}

export async function approvePolicy(db: DB, actor: Actor, id: string, reason?: string, opts?: ServiceOptions): Promise<CommercialPolicy> {
  assertCan(actor, "policy.approve");
  return db.transaction(async (tx) => {
    const [draft] = await tx.select().from(commercialPolicies).where(eq(commercialPolicies.id, id)).for("update");
    if (!draft) throw new CatalogueError("NOT_FOUND", "Policy not found");
    if (draft.status !== "draft") throw new CatalogueError("NOT_DRAFT", "Only draft policies can be approved.");
    if (draft.createdBy === actor.id && !selfApprovalAllowed(opts)) {
      throw new CatalogueError("SELF_APPROVAL", "The person who drafted the policy cannot approve it.");
    }
    const total = draft.paymentMilestones.reduce((s, m) => s + m.percentBp, 0);
    if (draft.paymentMilestones.length === 0 || total !== 10000) {
      throw new CatalogueError("MILESTONES_INVALID", `Payment milestones must add up to exactly 100% (currently ${total / 100}%).`);
    }
    if (draft.quoteValidityDays === null) throw new CatalogueError("VALIDITY_MISSING", "Set how many days a quotation stays valid before approving.");

    const [previous] = await tx.select().from(commercialPolicies)
      .where(and(eq(commercialPolicies.code, draft.code), eq(commercialPolicies.status, "approved"))).for("update");
    if (previous) {
      const [retired] = await tx.update(commercialPolicies).set({ status: "retired" }).where(eq(commercialPolicies.id, previous.id)).returning();
      await writeAudit(tx, actor, { action: "policy.retired", entityType: "commercial_policy", entityId: previous.id, before: previous, after: retired, reason: `Superseded by version ${draft.version}` });
    }
    const [approved] = await tx.update(commercialPolicies).set({ status: "approved", approvedBy: actor.id, approvedAt: new Date() })
      .where(eq(commercialPolicies.id, id)).returning();
    await writeAudit(tx, actor, { action: "policy.approved", entityType: "commercial_policy", entityId: id, before: draft, after: approved, reason });
    return approved;
  });
}

export async function loadActivePolicy(db: DB): Promise<CommercialPolicy | null> {
  const [row] = await db.select().from(commercialPolicies)
    .where(and(eq(commercialPolicies.code, "DEFAULT"), eq(commercialPolicies.status, "approved")));
  return row ?? null;
}
