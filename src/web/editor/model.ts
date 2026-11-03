/**
 * The quotation editor's form state, and conversion to/from the saved quotation.
 * Shared by the server (to fill the editor) and the browser (to send it back).
 * Inputs are kept as typed text so half-typed values ("12.") don't jump around;
 * they're parsed when calculating and when saving.
 */
import type { Quotation, QuotationLine, QuotationVersion } from "@/db/schema";
import type { QuotePayloadInput } from "@/quotations/service";
import {
  bpToInput, computeTotals, lineTotal, parsePercent, parseRinggit, senToInput, splitMilestones, validUnitLabel,
  type Discount, type Tax,
} from "@/quotations/calc";

export interface EditorLine {
  key: string;
  catalogueItemId: string | null;
  category: string | null;
  description: string;
  details: string;
  quantity: string;
  unitLabel: string;
  /** "" = Price review required. */
  unitPrice: string;
}
export interface EditorMilestone { key: string; label: string; timing: string }
export interface EditorPayment { key: string; label: string; percent: string }

export interface EditorState {
  id: string | null;
  number: string | null;
  version: number;
  updatedAt: string | null;
  quoteDate: string;
  validUntil: string;
  client: { company: string; contactName: string; email: string; phone: string; address: string };
  projectTitle: string;
  overview: string;
  objectives: string[];
  services: string[];
  features: string[];
  technicalRequirements: string[];
  deliverables: string[];
  exclusions: string[];
  assumptions: string[];
  lines: EditorLine[];
  discountType: "none" | "amount" | "percent";
  discountValue: string;
  discountLabel: string;
  taxEnabled: boolean;
  taxLabel: string;
  taxRate: string;
  timelineDuration: string;
  timelineMilestones: EditorMilestone[];
  paymentMilestones: EditorPayment[];
  paymentNotes: string;
  termsTemplateId: string | null;
  termsSourceVersionId: string | null;
  termsText: string;
  projectTerms: string;
  internalNotes: string;
}

let seq = 0;
export function newKey(prefix = "k"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface Defaults {
  quoteDate: string;
  validUntil: string;
  paymentMilestones: { label: string; percentBp: number }[];
  tax: { label: string; rateBp: number } | null;
  terms: { templateId: string | null; text: string | null };
}

export function blankState(d: Defaults): EditorState {
  return {
    id: null, number: null, version: 1, updatedAt: null,
    quoteDate: d.quoteDate, validUntil: d.validUntil,
    client: { company: "", contactName: "", email: "", phone: "", address: "" },
    projectTitle: "", overview: "",
    objectives: [], services: [], features: [], technicalRequirements: [], deliverables: [], exclusions: [], assumptions: [],
    lines: [{ key: newKey("l"), catalogueItemId: null, category: null, description: "", details: "", quantity: "1", unitLabel: "", unitPrice: "" }],
    discountType: "none", discountValue: "", discountLabel: "",
    taxEnabled: !!d.tax, taxLabel: d.tax?.label ?? "SST", taxRate: d.tax ? bpToInput(d.tax.rateBp) : "",
    timelineDuration: "", timelineMilestones: [],
    paymentMilestones: d.paymentMilestones.map((m) => ({ key: newKey("p"), label: m.label, percent: bpToInput(m.percentBp) })),
    paymentNotes: "",
    termsTemplateId: d.terms.templateId, termsSourceVersionId: null, termsText: d.terms.text ?? "", projectTerms: "",
    internalNotes: "",
  };
}

/** Lines saved before every line had a unit price (old "base + units" items) are shown as a single priced line. */
function lineFromSaved(l: QuotationLine): EditorLine {
  let quantity = l.quantity;
  let unit = l.unitPriceSen;
  let details = l.details ?? "";
  let unitLabel = l.unitLabel ?? "";
  if (unit === null && l.lineTotalSen !== null) {
    if (l.lineTotalSen % l.quantity === 0) unit = l.lineTotalSen / l.quantity;
    else {
      details = [details, `${l.quantity}${l.unitLabel ? ` ${l.unitLabel}` : ""}`].filter(Boolean).join(" · ");
      quantity = 1; unit = l.lineTotalSen; unitLabel = "";
    }
  }
  return {
    key: newKey("l"), catalogueItemId: l.catalogueItemId, category: l.category, description: l.description,
    details, quantity: String(quantity), unitLabel, unitPrice: senToInput(unit),
  };
}

export function stateFromSaved(q: Quotation, v: QuotationVersion, lines: QuotationLine[], d: Defaults): EditorState {
  return {
    id: q.id, number: q.number, version: v.version, updatedAt: q.updatedAt.toISOString(),
    quoteDate: v.quoteDate ?? d.quoteDate, validUntil: v.validUntil ?? "",
    client: {
      company: q.clientCompany, contactName: q.clientContactName ?? "", email: q.clientContactEmail ?? "",
      phone: q.clientContactPhone ?? "", address: q.clientAddress ?? "",
    },
    projectTitle: q.projectTitle, overview: v.scopeSummary ?? "",
    objectives: v.objectives, services: v.services, features: v.features, technicalRequirements: v.technicalRequirements,
    deliverables: v.deliverables, exclusions: v.exclusions, assumptions: v.assumptions,
    lines: lines.map(lineFromSaved),
    discountType: v.discountType ?? "none",
    discountValue: v.discountType === "amount" ? senToInput(v.discountValue) : v.discountType === "percent" ? bpToInput(v.discountValue) : "",
    discountLabel: v.discountLabel ?? "",
    taxEnabled: v.taxRateBp !== null, taxLabel: v.taxLabel ?? "SST", taxRate: bpToInput(v.taxRateBp),
    timelineDuration: v.timelineDuration ?? "",
    timelineMilestones: v.timelineMilestones.map((m) => ({ key: newKey("m"), label: m.label, timing: m.timing })),
    paymentMilestones: v.paymentMilestones.map((m) => ({ key: newKey("p"), label: m.label, percent: bpToInput(m.percentBp) })),
    paymentNotes: v.paymentNotes ?? "",
    termsTemplateId: v.termsTemplateId, termsSourceVersionId: v.termsSourceVersionId,
    termsText: v.termsText ?? "", projectTerms: v.projectTerms ?? "", internalNotes: v.internalNotes ?? "",
  };
}

// ---------- Browser side: live maths and conversion for saving ----------

export function parseQty(s: string): number | null {
  return /^\s*\d{1,6}\s*$/.test(s) && Number(s) >= 1 ? Number(s) : null;
}

export function discountFrom(s: EditorState): Discount {
  if (s.discountType === "none") return null;
  const value = s.discountType === "amount" ? parseRinggit(s.discountValue) : parsePercent(s.discountValue);
  if (value === null || Number.isNaN(value) || value <= 0) return null;
  return { type: s.discountType, value, label: s.discountLabel.trim() || null };
}

export function taxFrom(s: EditorState): Tax {
  if (!s.taxEnabled) return null;
  const rate = parsePercent(s.taxRate);
  if (rate === null || Number.isNaN(rate)) return null;
  return { label: s.taxLabel.trim() || "Tax", rateBp: rate };
}

/** Live totals while typing (unfinished values count as empty). */
export function liveTotals(s: EditorState) {
  const lineTotals = new Map<string, number | null>();
  for (const l of s.lines) {
    const q = parseQty(l.quantity);
    const p = parseRinggit(l.unitPrice);
    let t: number | null = null;
    try { t = q !== null && p !== null && !Number.isNaN(p) ? lineTotal(p, q) : null; } catch { t = null; }
    lineTotals.set(l.key, t);
  }
  let totals = { subtotalSen: 0, discountSen: 0, taxSen: 0, totalSen: 0 };
  try { totals = computeTotals([...lineTotals.values()].map((lineTotalSen) => ({ lineTotalSen })), discountFrom(s), taxFrom(s)); } catch { /* too large: shown as 0 until fixed */ }
  const pays = s.paymentMilestones.map((m) => ({ label: m.label, percentBp: (() => { const v = parsePercent(m.percent); return v === null || Number.isNaN(v) ? 0 : v; })() }));
  const split = splitMilestones(totals.totalSen, pays);
  const percentSum = pays.reduce((a, m) => a + m.percentBp, 0);
  return { lineTotals, totals, split, percentSum };
}

export type FieldErrors = Record<string, string>;

/** Convert the form into what the server expects. Format problems are returned per field. */
export function toPayload(s: EditorState): { payload: QuotePayloadInput; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const lines = s.lines
    .filter((l) => l.description.trim() || l.details.trim() || l.unitPrice.trim())
    .map((l, i) => {
      const n = i + 1;
      const quantity = parseQty(l.quantity);
      if (quantity === null) errors[`line.${l.key}.quantity`] = `Item ${n}: quantity must be a whole number of at least 1.`;
      const price = parseRinggit(l.unitPrice);
      if (price !== null && Number.isNaN(price)) errors[`line.${l.key}.unitPrice`] = `Item ${n}: unit price must be an amount like 1500 or 1500.50 (or empty if it still needs a price).`;
      if (!l.description.trim()) errors[`line.${l.key}.description`] = `Item ${n}: add a description.`;
      const unit = l.unitLabel.trim();
      if (unit && !validUnitLabel(unit)) errors[`line.${l.key}.unitLabel`] = `Item ${n}: the unit must be a word such as page, month or day.`;
      return {
        catalogueItemId: l.catalogueItemId, category: l.category, description: l.description, details: l.details,
        quantity: quantity ?? 1, unitLabel: unit, unitPriceSen: price === null || Number.isNaN(price) ? null : price,
      };
    });
  let discount: QuotePayloadInput["discount"] = null;
  if (s.discountType !== "none" && s.discountValue.trim()) {
    const value = s.discountType === "amount" ? parseRinggit(s.discountValue) : parsePercent(s.discountValue);
    if (value === null || Number.isNaN(value)) errors.discountValue = s.discountType === "amount" ? "Discount must be an amount like 500 or 500.00." : "Discount must be a percentage like 10 or 7.5.";
    else discount = { type: s.discountType, value, label: s.discountLabel };
  }
  let tax: QuotePayloadInput["tax"] = null;
  if (s.taxEnabled) {
    const rate = parsePercent(s.taxRate);
    if (rate === null || Number.isNaN(rate)) errors.taxRate = "Enter the tax rate as a percentage, e.g. 8.";
    if (!s.taxLabel.trim()) errors.taxLabel = "Enter the tax name, e.g. SST.";
    if (rate !== null && !Number.isNaN(rate) && s.taxLabel.trim()) tax = { label: s.taxLabel, rateBp: rate };
  }
  const payments = s.paymentMilestones.filter((m) => m.label.trim() || m.percent.trim()).map((m) => {
    const bp = parsePercent(m.percent);
    if (bp === null || Number.isNaN(bp) || bp <= 0) errors[`pay.${m.key}.percent`] = `Payment "${m.label || "?"}": enter a percentage above 0.`;
    if (!m.label.trim()) errors[`pay.${m.key}.label`] = "Each payment needs a name, e.g. Deposit.";
    return { label: m.label, percentBp: bp && !Number.isNaN(bp) ? bp : 0 };
  });
  if (!s.client.company.trim()) errors["client.company"] = "Enter the client's company name.";
  if (s.projectTitle.trim().length < 3) errors.projectTitle = "Enter a project title (at least 3 characters).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.quoteDate)) errors.quoteDate = "Enter the quotation date.";
  if (s.validUntil && s.validUntil < s.quoteDate) errors.validUntil = "The validity date is before the quotation date.";
  if (s.client.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.client.email.trim())) errors["client.email"] = "Enter a valid email or leave it blank.";

  return {
    errors,
    payload: {
      quoteDate: s.quoteDate, validUntil: s.validUntil || null,
      client: { ...s.client },
      projectTitle: s.projectTitle, overview: s.overview,
      objectives: s.objectives, services: s.services, features: s.features, technicalRequirements: s.technicalRequirements,
      deliverables: s.deliverables, exclusions: s.exclusions, assumptions: s.assumptions,
      lines, discount, tax,
      timeline: { duration: s.timelineDuration, milestones: s.timelineMilestones.map((m) => ({ label: m.label, timing: m.timing })) },
      payment: { milestones: payments, notes: s.paymentNotes },
      terms: { templateId: s.termsTemplateId, sourceVersionId: s.termsSourceVersionId, text: s.termsText, projectTerms: s.projectTerms },
      internalNotes: s.internalNotes,
      baseUpdatedAt: s.updatedAt,
    },
  };
}
