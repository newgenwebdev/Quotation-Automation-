/**
 * QUOTATION WORKFLOW
 *
 *   draft ──submit──► submitted ──approve──► approved ──► PDF for the client
 *     ▲                  │  └──reject──► rejected
 *     └────recall────────┘                   │
 *     └──────────── revise (new version) ◄───┘ (also from approved)
 *   any open quotation ──cancel──► cancelled
 *
 * Rules:
 *  - Sales build quotations from approved price-list items and/or custom lines.
 *  - EVERY quotation needs Finance approval before a client PDF exists.
 *  - Totals are calculated here in code, never typed. Catalogue lines are re-priced from the
 *    approved price list at submission, then frozen. Custom amounts are proposed by Sales and
 *    become official only when Finance approves them.
 *  - Approver must be a different person from whoever created or submitted the version.
 *  - Submitted/approved/rejected versions are frozen by the database itself.
 */
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import {
  quotations, quotationVersions, quotationLines, catalogueItems, termsTemplates,
  type Quotation, type QuotationVersion, type QuotationLine, type PolicySnapshot,
} from "@/db/schema";
import { MAX_TERMS_LENGTH, normaliseTerms } from "@/terms/service";
import { assertCan, can, PermissionError, type Actor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { calculatePrice, percentOf } from "@/pricing/engine";
import { loadActivePolicy } from "@/catalogue/service";

export class QuoteError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface QuoteBundle {
  quotation: Quotation;
  version: QuotationVersion;
  lines: QuotationLine[];
  versions: QuotationVersion[];
}

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}
function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function selfApprovalAllowed() {
  return process.env.ALLOW_SELF_APPROVAL === "true";
}

// ---------- Access ----------

export function canView(actor: Actor, q: Quotation): boolean {
  return q.ownerId === actor.id || can(actor, "quotes.viewAll");
}
export function canEdit(actor: Actor, q: Quotation, v: QuotationVersion): boolean {
  return v.status === "draft" && q.status !== "cancelled" && (q.ownerId === actor.id || actor.role === "admin");
}

async function loadForUpdate(tx: Pick<DB, "select">, actor: Actor, quotationId: string) {
  const [quotation] = await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update");
  if (!quotation) throw new QuoteError("NOT_FOUND", "Quotation not found.");
  if (!canView(actor, quotation)) throw new QuoteError("NOT_FOUND", "Quotation not found.");
  const [version] = await tx.select().from(quotationVersions)
    .where(and(eq(quotationVersions.quotationId, quotationId), eq(quotationVersions.version, quotation.currentVersion))).for("update");
  return { quotation, version };
}

function assertEditable(actor: Actor, q: Quotation, v: QuotationVersion) {
  if (q.status === "cancelled") throw new QuoteError("CANCELLED", "This quotation was cancelled.");
  if (v.status !== "draft") throw new QuoteError("NOT_DRAFT", "This version is no longer a draft. Recall it or create a revision to make changes.");
  if (q.ownerId !== actor.id && actor.role !== "admin") throw new PermissionError("quotes.create", actor.role);
}

export async function loadQuote(db: DB, actor: Actor, quotationId: string, versionNo?: number): Promise<QuoteBundle | null> {
  const [quotation] = await db.select().from(quotations).where(eq(quotations.id, quotationId));
  if (!quotation || !canView(actor, quotation)) return null;
  const versions = await db.select().from(quotationVersions)
    .where(eq(quotationVersions.quotationId, quotationId)).orderBy(asc(quotationVersions.version));
  const version = versions.find((v) => v.version === (versionNo ?? quotation.currentVersion));
  if (!version) return null;
  const lines = await db.select().from(quotationLines).where(eq(quotationLines.versionId, version.id)).orderBy(asc(quotationLines.position));
  return { quotation, version, lines, versions };
}

// ---------- Create & edit ----------

const optText = z.string().trim().transform((s) => (s === "" ? null : s)).nullable().default(null);

export const QuoteHeaderInput = z.object({
  clientCompany: z.string().trim().min(2, "Enter the client's company name"),
  clientContactName: optText,
  clientContactPhone: optText,
  clientContactEmail: z.string().trim().transform((s) => (s === "" ? null : s)).nullable().default(null)
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid client email or leave it blank"),
  projectTitle: z.string().trim().min(3, "Enter a project title"),
});

export async function createQuotation(db: DB, actor: Actor, raw: z.input<typeof QuoteHeaderInput>): Promise<Quotation> {
  assertCan(actor, "quotes.create");
  const input = QuoteHeaderInput.parse(raw);
  return db.transaction(async (tx) => {
    const [{ n }] = (await tx.execute(sql`SELECT nextval('quotation_number_seq')::int AS n`)).rows as { n: number }[];
    const number = `NGQ-${today().slice(0, 4)}-${String(n).padStart(4, "0")}`;
    const [quotation] = await tx.insert(quotations).values({ ...input, number, ownerId: actor.id }).returning();
    // Start with Finance's default T&C template, if one is set. Sales can change it per client.
    const [def] = await tx.select().from(termsTemplates).where(and(eq(termsTemplates.isDefault, true), eq(termsTemplates.active, true)));
    await tx.insert(quotationVersions).values({
      quotationId: quotation.id, version: 1, createdBy: actor.id,
      termsText: def?.body ?? null, termsTemplateId: def?.id ?? null,
    });
    await writeAudit(tx, actor, { action: "quote.created", entityType: "quotation", entityId: quotation.id, after: { number, clientCompany: input.clientCompany, projectTitle: input.projectTitle } });
    return quotation;
  });
}

export async function updateHeader(db: DB, actor: Actor, quotationId: string, raw: z.input<typeof QuoteHeaderInput>) {
  const input = QuoteHeaderInput.parse(raw);
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const [row] = await tx.update(quotations).set({ ...input, updatedAt: new Date() }).where(eq(quotations.id, quotationId)).returning();
    await writeAudit(tx, actor, { action: "quote.client_updated", entityType: "quotation", entityId: quotationId, before: pick(quotation), after: pick(row) });
    return row;
  });
}
function pick(q: Quotation) {
  return { clientCompany: q.clientCompany, clientContactName: q.clientContactName, clientContactPhone: q.clientContactPhone, clientContactEmail: q.clientContactEmail, projectTitle: q.projectTitle };
}

export const ScopeInput = z.object({
  scopeSummary: optText,
  deliverables: z.array(z.string().trim().min(1)).default([]),
  exclusions: z.array(z.string().trim().min(1)).default([]),
  confirmedTimeline: optText,
  internalNotes: optText,
});

export async function updateScope(db: DB, actor: Actor, quotationId: string, raw: z.input<typeof ScopeInput>) {
  const input = ScopeInput.parse(raw);
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    await tx.update(quotationVersions).set(input).where(eq(quotationVersions.id, version.id));
    await tx.update(quotations).set({ updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.scope_updated", entityType: "quotation", entityId: quotationId, reason: `v${version.version}` });
  });
}

async function nextPosition(tx: Pick<DB, "select">, versionId: string) {
  const [{ p }] = await tx.select({ p: max(quotationLines.position) }).from(quotationLines).where(eq(quotationLines.versionId, versionId));
  return (p ?? 0) + 1;
}

/** Add a line from the approved price list. The price shown is a preview; it's re-checked at submission. */
export async function addCatalogueLine(db: DB, actor: Actor, quotationId: string, raw: { catalogueCode: string; quantity: number; details?: string | null }) {
  const quantity = Number(raw.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) throw new QuoteError("BAD_QTY", "Quantity must be a whole number of at least 1.");
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const [item] = await tx.select().from(catalogueItems).where(and(eq(catalogueItems.code, raw.catalogueCode), eq(catalogueItems.status, "approved")));
    if (!item) throw new QuoteError("NOT_APPROVED", "That service has no approved price.");
    const existing = await tx.select({ code: quotationLines.catalogueCode }).from(quotationLines).where(eq(quotationLines.versionId, version.id));
    if (existing.some((e) => e.code === item.code)) throw new QuoteError("DUPLICATE", `${item.name} is already on this quotation. Change its quantity instead.`);

    const preview = calculatePrice(
      { currency: "MYR", asOf: today(), lines: [{ catalogueCode: item.code, quantity }], requestedByRole: actor.role },
      { catalogue: [{ ...item, kind: "package" }], policy: null },
    );
    const priced = preview.lines[0];
    if (!priced) {
      const why = preview.issues.find((i) => i.catalogueCode === item.code)?.message ?? "This item can't be priced at that quantity.";
      throw new QuoteError("CANT_PRICE", `${why} Use a custom line for anything outside the approved package.`);
    }
    const [line] = await tx.insert(quotationLines).values({
      versionId: version.id, position: await nextPosition(tx, version.id), kind: "catalogue",
      catalogueItemId: item.id, catalogueCode: item.code, catalogueVersion: item.version,
      description: item.name, details: raw.details?.trim() || null, quantity, unitLabel: item.unitLabel,
      // A unit price only makes sense when every unit costs the same.
      unitPriceSen: item.pricingModel === "base_plus_units" ? null : item.priceSen,
      lineTotalSen: priced.lineTotalSen,
    }).returning();
    await writeAudit(tx, actor, { action: "quote.line_added", entityType: "quotation", entityId: quotationId, after: { kind: "catalogue", code: item.code, quantity, lineTotalSen: priced.lineTotalSen } });
    return line;
  });
}

export const CustomLineInput = z.object({
  description: z.string().trim().min(3, "Describe the item"),
  details: optText,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1"),
  unitLabel: optText,
  /** null = price still needed (e.g. drafted by Quinn). Submission is blocked until it's filled in. */
  unitPriceSen: z.number().int().min(0, "Amount can't be negative").nullable(),
});

function customTotal(unitPriceSen: number | null, quantity: number): number | null {
  if (unitPriceSen === null) return null;
  const t = unitPriceSen * quantity;
  if (!Number.isSafeInteger(t)) throw new QuoteError("TOO_LARGE", "Amount is too large.");
  return t;
}

/** Add a custom line. Sales proposes the amount; Finance must approve the whole quotation. */
export async function addCustomLine(db: DB, actor: Actor, quotationId: string, raw: z.input<typeof CustomLineInput>) {
  const input = CustomLineInput.parse(raw);
  const lineTotalSen = customTotal(input.unitPriceSen, input.quantity);
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const [line] = await tx.insert(quotationLines).values({
      versionId: version.id, position: await nextPosition(tx, version.id), kind: "custom", ...input, lineTotalSen,
    }).returning();
    await writeAudit(tx, actor, { action: "quote.line_added", entityType: "quotation", entityId: quotationId, after: { kind: "custom", description: input.description, quantity: input.quantity, unitPriceSen: input.unitPriceSen } });
    return line;
  });
}

/** Edit a custom line (most often: fill in the price for a line Quinn drafted). */
export async function updateCustomLine(db: DB, actor: Actor, quotationId: string, lineId: string, raw: z.input<typeof CustomLineInput>) {
  const input = CustomLineInput.parse(raw);
  const lineTotalSen = customTotal(input.unitPriceSen, input.quantity);
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const [line] = await tx.select().from(quotationLines).where(and(eq(quotationLines.id, lineId), eq(quotationLines.versionId, version.id))).for("update");
    if (!line) throw new QuoteError("NOT_FOUND", "Line not found.");
    if (line.kind !== "custom") throw new QuoteError("NOT_CUSTOM", "Price-list items are priced automatically. Remove and re-add to change the quantity.");
    const [row] = await tx.update(quotationLines).set({ ...input, lineTotalSen }).where(eq(quotationLines.id, lineId)).returning();
    await tx.update(quotations).set({ updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, {
      action: "quote.line_updated", entityType: "quotation", entityId: quotationId,
      before: { description: line.description, quantity: line.quantity, unitPriceSen: line.unitPriceSen },
      after: { description: row.description, quantity: row.quantity, unitPriceSen: row.unitPriceSen },
    });
    return row;
  });
}

export async function removeLine(db: DB, actor: Actor, quotationId: string, lineId: string) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const [line] = await tx.delete(quotationLines).where(and(eq(quotationLines.id, lineId), eq(quotationLines.versionId, version.id))).returning();
    if (!line) throw new QuoteError("NOT_FOUND", "Line not found.");
    await writeAudit(tx, actor, { action: "quote.line_removed", entityType: "quotation", entityId: quotationId, before: { description: line.description, lineTotalSen: line.lineTotalSen } });
  });
}

// ---------- Totals (pure) ----------

export interface Totals { subtotalSen: number; tax: { label: string; rateBp: number; amountSen: number } | null; totalSen: number }

export function computeTotals(lines: Pick<QuotationLine, "lineTotalSen">[], tax: { label: string; rateBp: number } | null): Totals {
  const subtotalSen = lines.reduce((s, l) => s + (l.lineTotalSen ?? 0), 0);
  if (!Number.isSafeInteger(subtotalSen)) throw new QuoteError("TOO_LARGE", "Total is too large.");
  const taxLine = tax ? { ...tax, amountSen: percentOf(subtotalSen, tax.rateBp) } : null;
  return { subtotalSen, tax: taxLine, totalSen: subtotalSen + (taxLine?.amountSen ?? 0) };
}

/** Split a total into payment milestones. The last milestone absorbs any rounding sen, so they always add up exactly. */
export function splitMilestones(totalSen: number, milestones: { label: string; percentBp: number }[]) {
  let allocated = 0;
  return milestones.map((m, i) => {
    const amountSen = i === milestones.length - 1 ? totalSen - allocated : percentOf(totalSen, m.percentBp);
    allocated += amountSen;
    return { ...m, amountSen };
  });
}

// ---------- Submit, recall, approve, reject, revise, cancel ----------

export async function submitForApproval(db: DB, actor: Actor, quotationId: string) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const lines = await tx.select().from(quotationLines).where(eq(quotationLines.versionId, version.id)).orderBy(asc(quotationLines.position));
    if (lines.length === 0) throw new QuoteError("NO_LINES", "Add at least one line before submitting.");
    if (!version.scopeSummary) throw new QuoteError("NO_SCOPE", "Write a short scope summary before submitting.");
    if (!version.termsText?.trim()) throw new QuoteError("NO_TERMS", "Add the terms & conditions before submitting (choose a template or write them).");
    const unpriced = lines.filter((l) => l.lineTotalSen === null);
    if (unpriced.length) throw new QuoteError("UNPRICED", `Enter a price for: ${unpriced.map((l) => l.description).join("; ")}.`);

    const policy = await loadActivePolicy(tx as unknown as DB);
    if (!policy || policy.validFrom > today() || (policy.validTo && policy.validTo < today()) || policy.quoteValidityDays === null) {
      throw new QuoteError("NO_POLICY", "Finance hasn't approved payment terms yet, so quotations can't be submitted.");
    }

    // Re-price every price-list line from the CURRENT approved price list.
    const catLines = lines.filter((l) => l.kind === "catalogue");
    if (catLines.length) {
      const codes = catLines.map((l) => l.catalogueCode!);
      const catalogue = await tx.select().from(catalogueItems).where(inArray(catalogueItems.code, codes));
      const result = calculatePrice(
        { currency: "MYR", asOf: today(), lines: catLines.map((l) => ({ catalogueCode: l.catalogueCode!, quantity: l.quantity })), requestedByRole: actor.role },
        // Add-on rule relaxed here: custom lines may play the role of the base package.
        { catalogue: catalogue.map((c) => ({ ...c, kind: "package" as const })), policy },
      );
      const problems = result.issues.filter((i) => i.severity !== "needs_review");
      if (problems.length) throw new QuoteError("PRICING", problems.map((p) => p.message).join(" "));
      for (const l of catLines) {
        const p = result.lines.find((r) => r.catalogueCode === l.catalogueCode)!;
        const item = catalogue.find((c) => c.id === p.catalogueItemId)!;
        await tx.update(quotationLines).set({
          catalogueItemId: p.catalogueItemId, catalogueVersion: p.catalogueVersion, lineTotalSen: p.lineTotalSen,
          unitPriceSen: item.pricingModel === "base_plus_units" ? null : item.priceSen,
        })
          .where(eq(quotationLines.id, l.id));
        l.lineTotalSen = p.lineTotalSen;
      }
    }

    const taxConf = policy.taxEnabled && policy.taxLabel && policy.taxRateBp !== null ? { label: policy.taxLabel, rateBp: policy.taxRateBp } : null;
    const totals = computeTotals(lines, taxConf);
    const snapshot: PolicySnapshot = {
      policyId: policy.id, policyVersion: policy.version, paymentMilestones: policy.paymentMilestones,
      quoteValidityDays: policy.quoteValidityDays, tax: taxConf, termsText: policy.termsText,
    };
    const [v] = await tx.update(quotationVersions).set({
      status: "submitted", submittedBy: actor.id, submittedAt: new Date(),
      subtotalSen: totals.subtotalSen, taxSen: totals.tax?.amountSen ?? 0, totalSen: totals.totalSen, policySnapshot: snapshot,
    }).where(eq(quotationVersions.id, version.id)).returning();
    await tx.update(quotations).set({ status: "pending_approval", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.submitted", entityType: "quotation", entityId: quotationId, after: { version: v.version, totalSen: v.totalSen }, reason: `v${v.version}` });
    return v;
  });
}

/** Sales pulls a submitted quotation back to draft to make changes (before Finance decides). */
export async function recallSubmission(db: DB, actor: Actor, quotationId: string) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    if (version.status !== "submitted") throw new QuoteError("NOT_SUBMITTED", "Only a quotation waiting for approval can be recalled.");
    if (quotation.ownerId !== actor.id && actor.role !== "admin") throw new PermissionError("quotes.create", actor.role);
    await tx.update(quotationVersions).set({ status: "draft", submittedBy: null, submittedAt: null, subtotalSen: null, taxSen: null, totalSen: null, policySnapshot: null })
      .where(eq(quotationVersions.id, version.id));
    await tx.update(quotations).set({ status: "draft", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.recalled", entityType: "quotation", entityId: quotationId, reason: `v${version.version}` });
  });
}

async function decide(db: DB, actor: Actor, quotationId: string, decision: "approved" | "rejected", note: string | null) {
  assertCan(actor, "quotes.approve");
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    if (version.status !== "submitted") throw new QuoteError("NOT_SUBMITTED", "This quotation isn't waiting for approval.");
    if ((version.createdBy === actor.id || version.submittedBy === actor.id) && !selfApprovalAllowed()) {
      throw new QuoteError("SELF_APPROVAL", "You prepared this quotation, so another Finance or Admin person must decide on it.");
    }
    const validUntil = decision === "approved" ? addDays(today(), version.policySnapshot!.quoteValidityDays) : null;
    const [v] = await tx.update(quotationVersions).set({ status: decision, decidedBy: actor.id, decidedAt: new Date(), decisionNote: note, validUntil })
      .where(eq(quotationVersions.id, version.id)).returning();
    await tx.update(quotations).set({ status: decision, updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: `quote.${decision}`, entityType: "quotation", entityId: quotationId, after: { version: v.version, totalSen: v.totalSen, validUntil }, reason: note ?? undefined });
    return v;
  });
}

export async function approveQuotation(db: DB, actor: Actor, quotationId: string, note?: string | null) {
  return decide(db, actor, quotationId, "approved", note?.trim() || null);
}
export async function rejectQuotation(db: DB, actor: Actor, quotationId: string, note: string) {
  if (!note || note.trim().length < 5) throw new QuoteError("REASON_REQUIRED", "Tell Sales what to change (at least a few words).");
  return decide(db, actor, quotationId, "rejected", note.trim());
}

/** Start a new version from an approved or rejected one. The old version stays as a frozen record. */
export async function reviseQuotation(db: DB, actor: Actor, quotationId: string) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    if (quotation.status === "cancelled") throw new QuoteError("CANCELLED", "This quotation was cancelled.");
    if (!["approved", "rejected"].includes(version.status)) throw new QuoteError("NOT_DECIDED", "Only an approved or rejected quotation can be revised.");
    if (quotation.ownerId !== actor.id && actor.role !== "admin") throw new PermissionError("quotes.create", actor.role);
    const next = version.version + 1;
    const [nv] = await tx.insert(quotationVersions).values({
      quotationId, version: next, createdBy: actor.id,
      scopeSummary: version.scopeSummary, deliverables: version.deliverables, exclusions: version.exclusions,
      confirmedTimeline: version.confirmedTimeline, internalNotes: version.internalNotes,
      termsText: version.termsText, termsTemplateId: version.termsTemplateId, termsSourceVersionId: version.termsSourceVersionId,
      aiNotes: version.aiNotes,
    }).returning();
    const oldLines = await tx.select().from(quotationLines).where(eq(quotationLines.versionId, version.id)).orderBy(asc(quotationLines.position));
    for (const l of oldLines) {
      const { id: _id, versionId: _v, ...rest } = l;
      await tx.insert(quotationLines).values({ ...rest, versionId: nv.id });
    }
    await tx.update(quotations).set({ currentVersion: next, status: "draft", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.revised", entityType: "quotation", entityId: quotationId, reason: `v${version.version} → v${next}` });
    return nv;
  });
}

export async function cancelQuotation(db: DB, actor: Actor, quotationId: string, reason: string) {
  if (!reason || reason.trim().length < 5) throw new QuoteError("REASON_REQUIRED", "Give a reason for cancelling.");
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    if (quotation.status === "cancelled") throw new QuoteError("CANCELLED", "Already cancelled.");
    if (quotation.ownerId !== actor.id && !["admin", "finance"].includes(actor.role)) throw new PermissionError("quotes.create", actor.role);
    if (version.status === "draft" || version.status === "submitted") {
      await tx.update(quotationVersions).set({ status: "cancelled" }).where(eq(quotationVersions.id, version.id));
    }
    await tx.update(quotations).set({ status: "cancelled", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.cancelled", entityType: "quotation", entityId: quotationId, reason: reason.trim() });
  });
}

// ---------- Terms & conditions ----------

/** Save the terms Sales wrote or adjusted for this client. */
export async function updateTerms(db: DB, actor: Actor, quotationId: string, raw: string) {
  const termsText = normaliseTerms(raw);
  if (termsText.length > MAX_TERMS_LENGTH) throw new QuoteError("TOO_LONG", `Terms & conditions are too long (max ${MAX_TERMS_LENGTH.toLocaleString()} characters).`);
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    if (normaliseTerms(version.termsText) === termsText) return;
    // Clearing the box also forgets where the old terms came from.
    const patch = termsText === "" ? { termsText: null, termsTemplateId: null, termsSourceVersionId: null } : { termsText };
    await tx.update(quotationVersions).set(patch).where(eq(quotationVersions.id, version.id));
    await tx.update(quotations).set({ updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.terms_updated", entityType: "quotation", entityId: quotationId, before: { termsText: version.termsText }, after: { termsText: patch.termsText }, reason: `v${version.version}` });
  });
}

export type TermsSource = { kind: "template"; templateId: string } | { kind: "previous"; versionId: string };

/** Replace the terms with a template, or with the terms this client was approved for before. */
export async function loadTerms(db: DB, actor: Actor, quotationId: string, source: TermsSource) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    let patch: Pick<QuotationVersion, "termsText" | "termsTemplateId" | "termsSourceVersionId">;
    let from: string;
    if (source.kind === "template") {
      const [t] = await tx.select().from(termsTemplates).where(and(eq(termsTemplates.id, source.templateId), eq(termsTemplates.active, true)));
      if (!t) throw new QuoteError("NOT_FOUND", "That T&C template isn't available any more.");
      patch = { termsText: t.body, termsTemplateId: t.id, termsSourceVersionId: null };
      from = `template "${t.name}"`;
    } else {
      const [row] = await tx.select({ v: quotationVersions, q: quotations }).from(quotationVersions)
        .innerJoin(quotations, eq(quotations.id, quotationVersions.quotationId))
        .where(eq(quotationVersions.id, source.versionId));
      // Only Finance-approved terms, and only from quotations this person is allowed to see.
      if (!row || !canView(actor, row.q) || row.v.status !== "approved" || !row.v.termsText) {
        throw new QuoteError("NOT_FOUND", "Those terms aren't available.");
      }
      patch = { termsText: row.v.termsText, termsTemplateId: null, termsSourceVersionId: row.v.id };
      from = `${row.q.number} v${row.v.version}`;
    }
    await tx.update(quotationVersions).set(patch).where(eq(quotationVersions.id, version.id));
    await tx.update(quotations).set({ updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.terms_loaded", entityType: "quotation", entityId: quotationId, before: { termsText: version.termsText }, after: { termsText: patch.termsText }, reason: `From ${from}` });
  });
}

/** "ABC Sdn. Bhd." and "abc sdn bhd" are the same client. */
export function clientKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Approved terms from this client's earlier quotations that this person can see (newest first). */
export async function previousTermsFor(db: DB, actor: Actor, quotation: Quotation) {
  return db.select({ versionId: quotationVersions.id, number: quotations.number, version: quotationVersions.version, decidedAt: quotationVersions.decidedAt })
    .from(quotationVersions)
    .innerJoin(quotations, eq(quotations.id, quotationVersions.quotationId))
    .where(and(
      eq(quotationVersions.status, "approved"),
      isNotNull(quotationVersions.termsText),
      ne(quotations.id, quotation.id),
      sql`regexp_replace(lower(${quotations.clientCompany}), '[^a-z0-9]', '', 'g') = ${clientKey(quotation.clientCompany)}`,
      can(actor, "quotes.viewAll") ? undefined : eq(quotations.ownerId, actor.id),
    ))
    .orderBy(desc(quotationVersions.decidedAt)).limit(10);
}

export type TermsStatus =
  | { kind: "none" }
  | { kind: "template"; name: string; edited: boolean }
  | { kind: "previous"; label: string; edited: boolean }
  | { kind: "custom" };

type TermsFields = Pick<QuotationVersion, "id" | "termsText" | "termsTemplateId" | "termsSourceVersionId">;

/** Where each version's terms came from and whether they were changed, so Finance knows what to read closely. */
export async function resolveTermsStatus(db: DB, versions: TermsFields[]): Promise<Map<string, TermsStatus>> {
  const tIds = [...new Set(versions.map((v) => v.termsTemplateId).filter((x): x is string => !!x))];
  const sIds = [...new Set(versions.map((v) => v.termsSourceVersionId).filter((x): x is string => !!x))];
  const templates = tIds.length ? await db.select({ id: termsTemplates.id, name: termsTemplates.name, body: termsTemplates.body }).from(termsTemplates).where(inArray(termsTemplates.id, tIds)) : [];
  const sources = sIds.length
    ? await db.select({ id: quotationVersions.id, termsText: quotationVersions.termsText, version: quotationVersions.version, number: quotations.number })
      .from(quotationVersions).innerJoin(quotations, eq(quotations.id, quotationVersions.quotationId)).where(inArray(quotationVersions.id, sIds))
    : [];
  const out = new Map<string, TermsStatus>();
  for (const v of versions) {
    const text = normaliseTerms(v.termsText);
    const src = sources.find((s) => s.id === v.termsSourceVersionId);
    const tpl = templates.find((t) => t.id === v.termsTemplateId);
    if (!text) out.set(v.id, { kind: "none" });
    else if (src) out.set(v.id, { kind: "previous", label: `${src.number} v${src.version}`, edited: normaliseTerms(src.termsText) !== text });
    else if (tpl) out.set(v.id, { kind: "template", name: tpl.name, edited: normaliseTerms(tpl.body) !== text });
    else out.set(v.id, { kind: "custom" });
  }
  return out;
}

export function describeTerms(s: TermsStatus | undefined): { label: string; short: string; review: boolean } {
  switch (s?.kind) {
    case undefined:
    case "none": return { label: "No terms & conditions yet", short: "Missing", review: true };
    case "template": return s.edited
      ? { label: `Edited from the "${s.name}" template`, short: "Edited", review: true }
      : { label: `Standard "${s.name}" template, unchanged`, short: "Standard", review: false };
    case "previous": return s.edited
      ? { label: `Edited from the terms approved in ${s.label}`, short: "Edited", review: true }
      : { label: `Same terms as approved in ${s.label}`, short: "Same as before", review: false };
    case "custom": return { label: "Written specially for this quotation", short: "Custom", review: true };
  }
}

export async function logPdfDownload(db: DB, actor: Actor, quotationId: string, version: number, kind: "client" | "draft_preview") {
  await writeAudit(db, actor, { action: kind === "client" ? "quote.pdf_downloaded" : "quote.pdf_preview", entityType: "quotation", entityId: quotationId, reason: `v${version}` });
}
