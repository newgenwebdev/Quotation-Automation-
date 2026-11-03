/**
 * QUOTATIONS
 *
 *   draft ──finalise──► finalised ──mark as sent──► sent
 *     ▲                     │                         │
 *     └──── edit (starts a new draft version) ◄───────┘
 *   any open quotation ──cancel──► cancelled
 *
 * Both ways of creating a quotation — "Generate with Quinn" and "Generate manually" — end in
 * saveDraft(): one data model, one editor, one PDF.
 *
 * Rules:
 *  - Totals are always calculated here (calc.ts), never typed or trusted from the browser.
 *  - A line with no unit price is "Price review required"; the quotation can be saved but not
 *    finalised until someone enters the price (checked here AND by the database).
 *  - A finalised version is frozen by the database. Editing it starts a new draft version.
 *  - The creator ("Created by") is kept for tracking. Every change goes to the audit log.
 */
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db/client";
import {
  quotations, quotationVersions, quotationLines, termsTemplates, users,
  type Quotation, type QuotationVersion, type QuotationLine, type QuinnNotes, type QuoteStatus,
} from "@/db/schema";
import { assertCan, can, PermissionError, type Actor } from "@/auth/permissions";
import { writeAudit } from "@/audit/log";
import { loadActivePolicy, loadCatalogueByIds } from "@/catalogue/service";
import {
  addDays, computeTotals, daysBetween, isListedPrice, lineTotal, reviewQuote, todayKL, validUnitLabel,
  type Discount, type Tax, type Totals,
} from "./calc";

export class QuoteError extends Error {
  constructor(public code: string, message: string, public details?: string[]) { super(message); }
}

export interface QuoteBundle {
  quotation: Quotation;
  version: QuotationVersion;
  lines: QuotationLine[];
  versions: QuotationVersion[];
}

// ---------- The editor's payload (validated here; the browser is never trusted) ----------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const opt = (max: number, what: string) => z.string().trim().max(max, `${what} is too long (max ${max.toLocaleString()} characters)`)
  .transform((s) => (s === "" ? null : s)).nullable().default(null);
const list = (what: string) => z.array(z.string()).max(60, `Too many ${what} (max 60)`).default([])
  .transform((xs) => xs.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean))
  .refine((xs) => xs.every((x) => x.length <= 600), `Each of the ${what} must be under 600 characters`);

export const LineInput = z.object({
  catalogueItemId: uuid.nullable().default(null),
  category: opt(40, "Category"),
  description: z.string().trim().min(1, "Every pricing item needs a description").max(300, "An item description is too long (max 300 characters)"),
  details: opt(1000, "Item details"),
  quantity: z.number({ message: "Quantity must be a whole number" }).int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(100_000, "Quantity is too large"),
  unitLabel: z.string().trim().max(20).transform((s) => (s === "" ? null : s)).nullable().default(null)
    .refine((u) => u === null || validUnitLabel(u), "A unit must be a word such as page, month or day (not a number)"),
  /** null = Price review required. */
  unitPriceSen: z.number({ message: "Unit price must be an amount" }).int().min(0, "Prices can't be negative").max(100_000_000_000, "A unit price is too large").nullable(),
});

export const QuotePayload = z.object({
  quoteDate: isoDate,
  validUntil: isoDate.nullable().default(null),
  client: z.object({
    company: z.string().trim().min(2, "Enter the client's company name").max(200, "Client company is too long"),
    contactName: opt(120, "Contact person"),
    email: z.string().trim().max(200).transform((s) => (s === "" ? null : s)).nullable().default(null)
      .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid client email or leave it blank"),
    phone: opt(40, "Phone"),
    address: opt(500, "Company address"),
  }),
  projectTitle: z.string().trim().min(3, "Enter a project title (at least 3 characters)").max(200, "Project title is too long"),
  overview: opt(6000, "Project overview"),
  objectives: list("objectives"),
  services: list("services"),
  features: list("features"),
  technicalRequirements: list("technical requirements"),
  deliverables: list("deliverables"),
  exclusions: list("exclusions"),
  assumptions: list("assumptions"),
  lines: z.array(LineInput).max(150, "Too many pricing items (max 150)").default([]),
  discount: z.object({
    type: z.enum(["amount", "percent"]),
    value: z.number().int().min(0, "Discount can't be negative"),
    label: opt(100, "Discount label"),
  }).nullable().default(null)
    .refine((d) => d === null || d.type === "amount" || d.value <= 10000, "A percentage discount can't be more than 100%"),
  tax: z.object({
    label: z.string().trim().min(1, "Enter the tax name, e.g. SST").max(40),
    rateBp: z.number().int().min(0).max(10000, "Tax rate can't be more than 100%"),
  }).nullable().default(null),
  timeline: z.object({
    duration: opt(200, "Estimated duration"),
    milestones: z.array(z.object({ label: z.string().trim().max(200), timing: z.string().trim().max(100) })).max(30).default([])
      .transform((ms) => ms.filter((m) => m.label || m.timing))
      .refine((ms) => ms.every((m) => m.label.length > 0), "Each timeline milestone needs a name"),
  }).default({ duration: null, milestones: [] }),
  payment: z.object({
    milestones: z.array(z.object({
      label: z.string().trim().min(1, "Each payment needs a name, e.g. Deposit").max(100),
      percentBp: z.number().int().min(1, "Each payment needs a percentage above 0").max(10000),
    })).max(12).default([]),
    notes: opt(2000, "Payment notes"),
  }).default({ milestones: [], notes: null }),
  terms: z.object({
    templateId: uuid.nullable().default(null),
    sourceVersionId: uuid.nullable().default(null),
    text: opt(20000, "Terms & conditions"),
    projectTerms: opt(10000, "Project-specific terms"),
  }).default({ templateId: null, sourceVersionId: null, text: null, projectTerms: null }),
  internalNotes: opt(5000, "Internal notes"),
  /** The quotation's "last updated" time when the editor loaded it, to catch two people editing at once. */
  baseUpdatedAt: z.string().nullable().optional(),
}).superRefine((p, ctx) => {
  if (p.validUntil && p.validUntil < p.quoteDate) ctx.addIssue({ code: "custom", message: "The validity date is before the quotation date.", path: ["validUntil"] });
});
export type QuotePayload = z.infer<typeof QuotePayload>;
export type QuotePayloadInput = z.input<typeof QuotePayload>;

// ---------- Access ----------

export function canView(actor: Actor, q: Quotation): boolean {
  return q.ownerId === actor.id || can(actor, "quotes.viewAll");
}
export function canEdit(actor: Actor, q: Quotation, v: QuotationVersion): boolean {
  return v.status === "draft" && q.status !== "cancelled" && q.currentVersion === v.version && canView(actor, q) && can(actor, "quotes.create");
}

async function loadForUpdate(tx: Pick<DB, "select">, actor: Actor, quotationId: string) {
  const [quotation] = await tx.select().from(quotations).where(eq(quotations.id, quotationId)).for("update");
  if (!quotation || !canView(actor, quotation)) throw new QuoteError("NOT_FOUND", "Quotation not found.");
  const [version] = await tx.select().from(quotationVersions)
    .where(and(eq(quotationVersions.quotationId, quotationId), eq(quotationVersions.version, quotation.currentVersion))).for("update");
  return { quotation, version };
}

function assertEditable(actor: Actor, q: Quotation, v: QuotationVersion) {
  assertCan(actor, "quotes.create");
  if (q.status === "cancelled") throw new QuoteError("CANCELLED", "This quotation was cancelled.");
  if (v.status !== "draft") throw new QuoteError("NOT_DRAFT", "This quotation is finalised. Use “Edit” to start a new version.");
}

export async function loadQuote(db: DB, actor: Actor, quotationId: string, versionNo?: number): Promise<QuoteBundle | null> {
  if (!uuid.safeParse(quotationId).success) return null;
  const [quotation] = await db.select().from(quotations).where(eq(quotations.id, quotationId));
  if (!quotation || !canView(actor, quotation)) return null;
  const versions = await db.select().from(quotationVersions)
    .where(eq(quotationVersions.quotationId, quotationId)).orderBy(asc(quotationVersions.version));
  const version = versions.find((v) => v.version === (versionNo ?? quotation.currentVersion));
  if (!version) return null;
  const lines = await db.select().from(quotationLines).where(eq(quotationLines.versionId, version.id)).orderBy(asc(quotationLines.position));
  return { quotation, version, lines, versions };
}

// ---------- Saving ----------

function discountOf(p: QuotePayload): Discount {
  return p.discount && p.discount.value > 0 ? { type: p.discount.type, value: p.discount.value, label: p.discount.label } : null;
}
function taxOf(p: QuotePayload): Tax {
  return p.tax ? { label: p.tax.label, rateBp: p.tax.rateBp } : null;
}

/** Work out each line's amount and whether it really came from the price list at the listed price. */
async function prepareLines(tx: Pick<DB, "select">, p: QuotePayload) {
  const items = await loadCatalogueByIds(tx, [...new Set(p.lines.map((l) => l.catalogueItemId).filter((x): x is string => !!x))]);
  return p.lines.map((l, i) => {
    const item = l.catalogueItemId ? items.find((c) => c.id === l.catalogueItemId) : undefined;
    const fromList = !!item && isListedPrice(item, l.unitPriceSen);
    return {
      position: i + 1,
      kind: fromList ? ("catalogue" as const) : ("custom" as const),
      catalogueItemId: fromList ? item!.id : null,
      catalogueCode: fromList ? item!.code : null,
      catalogueVersion: fromList ? item!.version : null,
      category: l.category ?? (item?.category ?? null),
      description: l.description,
      details: l.details,
      quantity: l.quantity,
      unitLabel: l.unitLabel,
      unitPriceSen: l.unitPriceSen,
      lineTotalSen: lineTotal(l.unitPriceSen, l.quantity),
    };
  });
}

function versionFields(p: QuotePayload, totals: Totals) {
  const d = discountOf(p);
  const t = taxOf(p);
  return {
    quoteDate: p.quoteDate, validUntil: p.validUntil,
    scopeSummary: p.overview, objectives: p.objectives,
    services: p.services, features: p.features, technicalRequirements: p.technicalRequirements,
    deliverables: p.deliverables, exclusions: p.exclusions,
    discountType: d?.type ?? null, discountValue: d?.value ?? null, discountLabel: d?.label ?? null,
    taxLabel: t?.label ?? null, taxRateBp: t?.rateBp ?? null,
    ...totals,
    timelineDuration: p.timeline.duration, timelineMilestones: p.timeline.milestones,
    paymentMilestones: p.payment.milestones, paymentNotes: p.payment.notes,
    termsText: p.terms.text, termsTemplateId: p.terms.templateId, termsSourceVersionId: p.terms.sourceVersionId,
    projectTerms: p.terms.projectTerms, assumptions: p.assumptions, internalNotes: p.internalNotes,
  };
}

/** Only keep a terms "source" that really exists (a template, or a finalised quotation this person can see). */
async function checkTermsSource(tx: Pick<DB, "select">, actor: Actor, p: QuotePayload) {
  if (p.terms.templateId) {
    const [t] = await tx.select({ id: termsTemplates.id }).from(termsTemplates).where(eq(termsTemplates.id, p.terms.templateId));
    if (!t) p.terms.templateId = null;
  }
  if (p.terms.sourceVersionId) {
    const [row] = await tx.select({ v: quotationVersions, q: quotations }).from(quotationVersions)
      .innerJoin(quotations, eq(quotations.id, quotationVersions.quotationId)).where(eq(quotationVersions.id, p.terms.sourceVersionId));
    if (!row || row.v.status !== "finalised" || !canView(actor, row.q)) p.terms.sourceVersionId = null;
  }
  if (!p.terms.text) { p.terms.templateId = null; p.terms.sourceVersionId = null; }
}

export interface SaveOptions {
  quotationId?: string;
  aiNotes?: QuinnNotes | null;
  /** Who it's recorded as in the audit log (Quinn records its own entry as well). */
  auditReason?: string;
}

/** Create a new draft quotation, or update the current draft version of an existing one. */
export async function saveDraft(db: DB, actor: Actor, raw: QuotePayloadInput, opts: SaveOptions = {}): Promise<{ quotation: Quotation; version: QuotationVersion }> {
  assertCan(actor, "quotes.create");
  const p = QuotePayload.parse(raw);
  return db.transaction(async (tx) => {
    const lines = await prepareLines(tx, p);
    const totals = computeTotals(lines, discountOf(p), taxOf(p));
    await checkTermsSource(tx, actor, p);
    const clientFields = {
      clientCompany: p.client.company, clientContactName: p.client.contactName, clientContactEmail: p.client.email,
      clientContactPhone: p.client.phone, clientAddress: p.client.address, projectTitle: p.projectTitle,
    };

    if (!opts.quotationId) {
      const [{ n }] = (await tx.execute(sql`SELECT nextval('quotation_number_seq')::int AS n`)).rows as { n: number }[];
      const number = `NGQ-${todayKL().slice(0, 4)}-${String(n).padStart(4, "0")}`;
      const [quotation] = await tx.insert(quotations).values({ ...clientFields, number, ownerId: actor.id }).returning();
      const [version] = await tx.insert(quotationVersions).values({
        quotationId: quotation.id, version: 1, createdBy: actor.id, ...versionFields(p, totals), aiNotes: opts.aiNotes ?? null,
      }).returning();
      if (lines.length) await tx.insert(quotationLines).values(lines.map((l) => ({ ...l, versionId: version.id })));
      await writeAudit(tx, actor, {
        action: "quote.created", entityType: "quotation", entityId: quotation.id,
        after: { number, clientCompany: p.client.company, projectTitle: p.projectTitle, totalSen: totals.totalSen, lines: lines.length },
        reason: opts.auditReason,
      });
      return { quotation, version };
    }

    const { quotation: q, version: v } = await loadForUpdate(tx, actor, opts.quotationId);
    assertEditable(actor, q, v);
    if (p.baseUpdatedAt && new Date(p.baseUpdatedAt).getTime() !== q.updatedAt.getTime()) {
      throw new QuoteError("STALE", "Someone else saved this quotation after you opened it. Copy anything you need, then reload the page to see their changes. Your changes were NOT saved.");
    }
    const [quotation] = await tx.update(quotations).set({ ...clientFields, updatedAt: new Date() }).where(eq(quotations.id, q.id)).returning();
    const [version] = await tx.update(quotationVersions).set({
      ...versionFields(p, totals), ...(opts.aiNotes !== undefined ? { aiNotes: opts.aiNotes } : {}),
    }).where(eq(quotationVersions.id, v.id)).returning();
    await tx.delete(quotationLines).where(eq(quotationLines.versionId, v.id));
    if (lines.length) await tx.insert(quotationLines).values(lines.map((l) => ({ ...l, versionId: v.id })));
    await writeAudit(tx, actor, {
      action: "quote.saved", entityType: "quotation", entityId: q.id,
      before: { totalSen: v.totalSen, clientCompany: q.clientCompany, projectTitle: q.projectTitle },
      after: { totalSen: totals.totalSen, clientCompany: p.client.company, projectTitle: p.projectTitle, lines: lines.length },
      reason: opts.auditReason ?? `v${v.version}`,
    });
    return { quotation, version };
  });
}

// ---------- Finalise, sent, edit, duplicate, cancel ----------

export function reviewBundle(b: Pick<QuoteBundle, "quotation" | "version" | "lines">, today = todayKL()) {
  const { quotation: q, version: v, lines } = b;
  return reviewQuote({
    quoteDate: v.quoteDate, validUntil: v.validUntil, clientCompany: q.clientCompany, projectTitle: q.projectTitle,
    overview: v.scopeSummary, scopeCount: v.services.length + v.features.length + v.deliverables.length,
    lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceSen: l.lineTotalSen === null ? null : (l.unitPriceSen ?? l.lineTotalSen) })),
    discount: v.discountType ? { type: v.discountType, value: v.discountValue ?? 0, label: v.discountLabel } : null,
    subtotalSen: v.subtotalSen ?? 0, totalSen: v.totalSen ?? 0,
    paymentMilestones: v.paymentMilestones, termsText: v.termsText,
  }, today);
}

/** Lock the quotation as client-ready. No approval needed; blocked while anything is missing. */
export async function finaliseQuotation(db: DB, actor: Actor, quotationId: string): Promise<QuotationVersion> {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertEditable(actor, quotation, version);
    const lines = await tx.select().from(quotationLines).where(eq(quotationLines.versionId, version.id)).orderBy(asc(quotationLines.position));
    const { errors } = reviewBundle({ quotation, version, lines });
    if (errors.length) throw new QuoteError("NOT_READY", errors.join(" "), errors);
    const [v] = await tx.update(quotationVersions).set({ status: "finalised", finalisedBy: actor.id, finalisedAt: new Date() })
      .where(eq(quotationVersions.id, version.id)).returning();
    await tx.update(quotations).set({ status: "finalised", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.finalised", entityType: "quotation", entityId: quotationId, after: { version: v.version, totalSen: v.totalSen }, reason: `v${v.version}` });
    return v;
  });
}

export async function markSent(db: DB, actor: Actor, quotationId: string) {
  return db.transaction(async (tx) => {
    const { quotation } = await loadForUpdate(tx, actor, quotationId);
    assertCan(actor, "quotes.create");
    if (quotation.status !== "finalised") {
      throw new QuoteError("NOT_FINALISED", quotation.status === "sent" ? "Already marked as sent." : "Finalise the quotation before marking it as sent.");
    }
    await tx.update(quotations).set({ status: "sent", sentAt: new Date(), updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.sent", entityType: "quotation", entityId: quotationId, reason: `v${quotation.currentVersion}` });
  });
}

const CONTENT_COLUMNS = [
  "scopeSummary", "objectives", "services", "features", "technicalRequirements", "deliverables", "exclusions",
  "discountType", "discountValue", "discountLabel", "taxLabel", "taxRateBp", "currency",
  "subtotalSen", "discountSen", "taxSen", "totalSen", "timelineDuration", "timelineMilestones",
  "paymentMilestones", "paymentNotes", "termsText", "termsTemplateId", "termsSourceVersionId", "projectTerms", "assumptions",
] as const;
function copyContent(v: QuotationVersion) {
  return Object.fromEntries(CONTENT_COLUMNS.map((c) => [c, v[c]])) as Pick<QuotationVersion, (typeof CONTENT_COLUMNS)[number]>;
}
function newValidity(v: QuotationVersion, fallbackDays: number, today: string) {
  const days = v.quoteDate && v.validUntil ? Math.max(daysBetween(v.quoteDate, v.validUntil), 1) : fallbackDays;
  return { quoteDate: today, validUntil: addDays(today, days) };
}
async function copyLines(tx: Pick<DB, "select" | "insert">, fromVersionId: string, toVersionId: string) {
  const old = await tx.select().from(quotationLines).where(eq(quotationLines.versionId, fromVersionId)).orderBy(asc(quotationLines.position));
  if (old.length) await tx.insert(quotationLines).values(old.map(({ id: _id, versionId: _v, ...rest }) => ({ ...rest, versionId: toVersionId })));
}

/** "Edit" on a finalised (or sent) quotation: a new draft version; the finalised one stays as a record. */
export async function reviseQuotation(db: DB, actor: Actor, quotationId: string): Promise<QuotationVersion> {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertCan(actor, "quotes.create");
    if (quotation.status === "cancelled") throw new QuoteError("CANCELLED", "This quotation was cancelled.");
    if (version.status !== "finalised") throw new QuoteError("NOT_FINALISED", "This quotation is already a draft. Edit it directly.");
    const next = version.version + 1;
    const [nv] = await tx.insert(quotationVersions).values({
      quotationId, version: next, createdBy: actor.id, ...copyContent(version),
      ...newValidity(version, 30, todayKL()), internalNotes: version.internalNotes, aiNotes: version.aiNotes,
    }).returning();
    await copyLines(tx, version.id, nv.id);
    await tx.update(quotations).set({ currentVersion: next, status: "draft", sentAt: null, updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.revised", entityType: "quotation", entityId: quotationId, reason: `v${version.version} → v${next}` });
    return nv;
  });
}

/** A new quotation (new number, created by you) with the same content, dated today. */
export async function duplicateQuotation(db: DB, actor: Actor, quotationId: string): Promise<Quotation> {
  assertCan(actor, "quotes.create");
  return db.transaction(async (tx) => {
    const [src] = await tx.select().from(quotations).where(eq(quotations.id, quotationId));
    if (!src || !canView(actor, src)) throw new QuoteError("NOT_FOUND", "Quotation not found.");
    const [v] = await tx.select().from(quotationVersions)
      .where(and(eq(quotationVersions.quotationId, src.id), eq(quotationVersions.version, src.currentVersion)));
    const policy = await loadActivePolicy(tx);
    const today = todayKL();
    const [{ n }] = (await tx.execute(sql`SELECT nextval('quotation_number_seq')::int AS n`)).rows as { n: number }[];
    const number = `NGQ-${today.slice(0, 4)}-${String(n).padStart(4, "0")}`;
    const [copy] = await tx.insert(quotations).values({
      number, ownerId: actor.id, clientCompany: src.clientCompany, clientContactName: src.clientContactName,
      clientContactPhone: src.clientContactPhone, clientContactEmail: src.clientContactEmail, clientAddress: src.clientAddress,
      projectTitle: src.projectTitle,
    }).returning();
    const [nv] = await tx.insert(quotationVersions).values({
      quotationId: copy.id, version: 1, createdBy: actor.id, ...copyContent(v), ...newValidity(v, policy?.quoteValidityDays ?? 30, today),
    }).returning();
    await copyLines(tx, v.id, nv.id);
    await writeAudit(tx, actor, { action: "quote.created", entityType: "quotation", entityId: copy.id, after: { number, duplicatedFrom: src.number }, reason: `Duplicated from ${src.number} v${v.version}` });
    await writeAudit(tx, actor, { action: "quote.duplicated", entityType: "quotation", entityId: src.id, reason: `Copied to ${number}` });
    return copy;
  });
}

export async function cancelQuotation(db: DB, actor: Actor, quotationId: string, reason?: string | null) {
  return db.transaction(async (tx) => {
    const { quotation, version } = await loadForUpdate(tx, actor, quotationId);
    assertCan(actor, "quotes.create");
    if (quotation.status === "cancelled") throw new QuoteError("CANCELLED", "Already cancelled.");
    if (version.status === "draft") await tx.update(quotationVersions).set({ status: "cancelled" }).where(eq(quotationVersions.id, version.id));
    await tx.update(quotations).set({ status: "cancelled", updatedAt: new Date() }).where(eq(quotations.id, quotationId));
    await writeAudit(tx, actor, { action: "quote.cancelled", entityType: "quotation", entityId: quotationId, reason: reason?.trim() || undefined });
  });
}

// ---------- Lists, defaults, terms ----------

export interface QuoteListRow {
  id: string; number: string; clientCompany: string; projectTitle: string; status: QuoteStatus; currentVersion: number;
  createdBy: string; totalSen: number | null; unpriced: number; updatedAt: Date;
}

export async function listQuotations(db: DB, actor: Actor, f: { search?: string; status?: QuoteStatus | "all" } = {}): Promise<QuoteListRow[]> {
  const conds: (SQL | undefined)[] = [];
  if (!can(actor, "quotes.viewAll")) conds.push(eq(quotations.ownerId, actor.id));
  if (f.status && f.status !== "all") conds.push(eq(quotations.status, f.status));
  const s = f.search?.trim().slice(0, 100);
  if (s) {
    const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(quotations.number, like), ilike(quotations.clientCompany, like), ilike(quotations.projectTitle, like), ilike(quotations.clientContactName, like)));
  }
  const rows = await db.select({
    q: quotations, createdBy: users.name, totalSen: quotationVersions.totalSen,
    unpriced: sql<number>`(SELECT count(*)::int FROM ${quotationLines} WHERE ${quotationLines.versionId} = ${quotationVersions.id} AND ${quotationLines.lineTotalSen} IS NULL)`,
  }).from(quotations)
    .innerJoin(users, eq(users.id, quotations.ownerId))
    .innerJoin(quotationVersions, and(eq(quotationVersions.quotationId, quotations.id), eq(quotationVersions.version, quotations.currentVersion)))
    .where(and(...conds))
    .orderBy(desc(quotations.updatedAt)).limit(300);
  return rows.map(({ q, createdBy, totalSen, unpriced }) => ({
    id: q.id, number: q.number, clientCompany: q.clientCompany, projectTitle: q.projectTitle, status: q.status,
    currentVersion: q.currentVersion, createdBy, totalSen, unpriced, updatedAt: q.updatedAt,
  }));
}

/** Settings applied automatically to every new quotation (Quinn or manual). Nothing is made up: */
/** if Settings has no payment terms or T&C yet, those sections start empty. */
export async function newQuoteDefaults(db: Pick<DB, "select">) {
  const policy = await loadActivePolicy(db);
  const [template] = await db.select().from(termsTemplates).where(and(eq(termsTemplates.isDefault, true), eq(termsTemplates.active, true)));
  const today = todayKL();
  return {
    quoteDate: today,
    validUntil: addDays(today, policy?.quoteValidityDays ?? 30),
    validityDays: policy?.quoteValidityDays ?? 30,
    paymentMilestones: policy?.paymentMilestones ?? [],
    tax: policy?.taxEnabled && policy.taxLabel && policy.taxRateBp !== null ? { label: policy.taxLabel, rateBp: policy.taxRateBp } : null,
    terms: { templateId: template?.id ?? null, text: template?.body ?? null },
  };
}

/** "ABC Sdn. Bhd." and "abc sdn bhd" are the same client. */
export function clientKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** T&C from this client's earlier finalised quotations (newest first), so they can be reused. */
export async function previousTermsFor(db: DB, actor: Actor, clientCompany: string, excludeQuotationId?: string) {
  if (clientKey(clientCompany).length < 2) return [];
  return db.select({
    versionId: quotationVersions.id, number: quotations.number, version: quotationVersions.version,
    finalisedAt: quotationVersions.finalisedAt, termsText: quotationVersions.termsText,
  })
    .from(quotationVersions)
    .innerJoin(quotations, eq(quotations.id, quotationVersions.quotationId))
    .where(and(
      eq(quotationVersions.status, "finalised"),
      sql`coalesce(${quotationVersions.termsText}, '') <> ''`,
      excludeQuotationId ? sql`${quotations.id} <> ${excludeQuotationId}` : undefined,
      sql`regexp_replace(lower(${quotations.clientCompany}), '[^a-z0-9]', '', 'g') = ${clientKey(clientCompany)}`,
      can(actor, "quotes.viewAll") ? undefined : eq(quotations.ownerId, actor.id),
    ))
    .orderBy(desc(quotationVersions.finalisedAt)).limit(5);
}

export async function userNames(db: DB, ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return {};
  return Object.fromEntries((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique))).map((u) => [u.id, u.name]));
}

export function isClientReady(q: Quotation, v: QuotationVersion): boolean {
  return v.status === "finalised" && q.status !== "cancelled";
}

export async function logPdfDownload(db: DB, actor: Actor, quotationId: string, version: number, kind: "client" | "draft_preview") {
  await writeAudit(db, actor, { action: kind === "client" ? "quote.pdf_downloaded" : "quote.pdf_preview", entityType: "quotation", entityId: quotationId, reason: `v${version}` });
}

export { PermissionError };
