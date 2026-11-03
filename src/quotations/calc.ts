/**
 * QUOTATION MATHS AND CHECKS — pure functions, no database.
 *
 * The same code runs in the browser (live totals while typing) and on the server (the totals
 * that are actually saved), so the two can never disagree. Money is whole sen (RM 1.00 = 100),
 * percentages are basis points (8% = 800). Rounding is half-up, on whole sen.
 *
 * Order of calculation (standard for Malaysian SST):
 *   subtotal = Σ quantity × unit price
 *   discount = fixed amount, or % of subtotal (never more than the subtotal)
 *   tax      = rate × (subtotal − discount)
 *   total    = subtotal − discount + tax
 */

export type Discount = { type: "amount" | "percent"; value: number; label: string | null } | null;
export type Tax = { label: string; rateBp: number } | null;
export type PaymentMilestone = { label: string; percentBp: number };

export interface Totals {
  subtotalSen: number;
  discountSen: number;
  taxSen: number;
  totalSen: number;
}

export const MAX_SEN = 100_000_000_000; // RM 1 billion: anything above is a typo

export function percentOf(amountSen: number, bp: number): number {
  return Math.floor((amountSen * bp + 5000) / 10000);
}

export function lineTotal(unitPriceSen: number | null, quantity: number): number | null {
  if (unitPriceSen === null) return null;
  const t = unitPriceSen * quantity;
  if (!Number.isSafeInteger(t) || t > MAX_SEN) throw new CalcError("TOO_LARGE", "An amount is too large. Check the quantity and unit price.");
  return t;
}

export class CalcError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function computeTotals(lines: { lineTotalSen: number | null }[], discount: Discount, tax: Tax): Totals {
  const subtotalSen = lines.reduce((s, l) => s + (l.lineTotalSen ?? 0), 0);
  if (!Number.isSafeInteger(subtotalSen) || subtotalSen > MAX_SEN) throw new CalcError("TOO_LARGE", "The total is too large.");
  let discountSen = 0;
  if (discount) discountSen = discount.type === "amount" ? discount.value : percentOf(subtotalSen, discount.value);
  discountSen = Math.min(Math.max(discountSen, 0), subtotalSen);
  const taxable = subtotalSen - discountSen;
  const taxSen = tax ? percentOf(taxable, tax.rateBp) : 0;
  return { subtotalSen, discountSen, taxSen, totalSen: taxable + taxSen };
}

/** Split a total into payment milestones. The last one absorbs rounding, so they always add up exactly. */
export function splitMilestones(totalSen: number, milestones: PaymentMilestone[]) {
  let allocated = 0;
  return milestones.map((m, i) => {
    const amountSen = i === milestones.length - 1 ? totalSen - allocated : percentOf(totalSen, m.percentBp);
    allocated += amountSen;
    return { ...m, amountSen };
  });
}

// ---------- Formatting and parsing (shared by forms and the PDF) ----------

export function formatRM(sen: number, currency = "MYR"): string {
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  const ringgit = Math.floor(abs / 100).toLocaleString("en-MY");
  return `${sign}${currency === "MYR" ? "RM" : currency} ${ringgit}.${String(abs % 100).padStart(2, "0")}`;
}

/** "5,899.50" or "RM 5899.5" → 589950. "" → null. Anything else → NaN. Exact (no floating point). */
export function parseRinggit(input: string): number | null {
  const v = input.replace(/[,\s]/g, "").replace(/^RM/i, "");
  if (v === "") return null;
  const m = v.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export function senToInput(sen: number | null | undefined): string {
  if (sen === null || sen === undefined) return "";
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`;
}

/** "50" or "8.5%" → basis points. "" → null. Anything else → NaN. */
export function parsePercent(input: string): number | null {
  const v = input.replace("%", "").trim();
  if (v === "") return null;
  const m = v.match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export function bpToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "";
  return String(bp / 100);
}

export function percentLabel(bp: number): string {
  return `${bp / 100}%`;
}

/** "7 pages", "1 month", "3" — the unit is only shown when it's a word. */
export function quantityText(quantity: number, unitLabel: string | null): string {
  if (!unitLabel) return String(quantity);
  const plural = quantity !== 1 && /^[a-z]+$/i.test(unitLabel) && !/s$/i.test(unitLabel) ? `${unitLabel}s` : unitLabel;
  return `${quantity} ${plural}`;
}

/** A unit must be a word ("page", "man-day"), not a number: "1 20" makes no sense on a quotation. */
export function validUnitLabel(u: string): boolean {
  return u.length <= 20 && /[a-z]/i.test(u);
}

// ---------- Dates (Malaysia time) ----------

export function todayKL(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400_000);
}

// ---------- Price list → pricing lines ----------

export interface PriceListItem {
  id: string; code: string; version: number; name: string; category: string;
  pricingModel: "fixed" | "per_unit" | "base_plus_units";
  priceSen: number; includedUnits: number | null; extraUnitPriceSen: number | null;
  unitLabel: string | null; minQuantity: number; maxQuantity: number | null;
}

export interface PricedLine {
  catalogueItemId: string; catalogueCode: string; catalogueVersion: number; category: string;
  description: string; details: string | null; quantity: number; unitLabel: string | null; unitPriceSen: number;
}

/**
 * Turn "this price-list item × quantity" into pricing-table lines at the listed price.
 * Every line is quantity × unit price. "Base + extra units" becomes two lines (the package, then
 * the extra units), so the maths on the quotation is visible to the client.
 * Returns a plain-English problem instead when the quantity is outside what the price list covers.
 */
export function linesFromPriceList(item: PriceListItem, quantity: number, details: string | null = null): { lines: PricedLine[] } | { problem: string } {
  const unit = item.unitLabel ?? "unit";
  const ref = { catalogueItemId: item.id, catalogueCode: item.code, catalogueVersion: item.version, category: item.category };
  if (!Number.isInteger(quantity) || quantity < 1) return { problem: "Quantity must be a whole number of at least 1." };
  if (item.pricingModel === "fixed") {
    if (quantity !== 1) return { problem: `${item.name} is a fixed-price package (quantity 1 only).` };
    return { lines: [{ ...ref, description: item.name, details, quantity: 1, unitLabel: null, unitPriceSen: item.priceSen }] };
  }
  if (quantity < item.minQuantity) return { problem: `${item.name} starts at ${quantityText(item.minQuantity, unit)}.` };
  if (item.maxQuantity !== null && quantity > item.maxQuantity) {
    return { problem: `${item.name} covers up to ${quantityText(item.maxQuantity, unit)}; ${quantityText(quantity, unit)} needs a price review.` };
  }
  if (item.pricingModel === "per_unit") {
    return { lines: [{ ...ref, description: item.name, details, quantity, unitLabel: item.unitLabel, unitPriceSen: item.priceSen }] };
  }
  const included = item.includedUnits ?? 0;
  const lines: PricedLine[] = [{
    ...ref, description: item.name, details: details ?? `Includes up to ${quantityText(included, unit)}`,
    quantity: 1, unitLabel: null, unitPriceSen: item.priceSen,
  }];
  if (quantity > included) {
    lines.push({
      ...ref, description: `Additional ${unit}s`, details: `Beyond the ${quantityText(included, unit)} included in ${item.name}`,
      quantity: quantity - included, unitLabel: item.unitLabel, unitPriceSen: item.extraUnitPriceSen ?? 0,
    });
  }
  return { lines };
}

/** Is this unit price one the price-list item actually lists? (Otherwise the line counts as hand-priced.) */
export function isListedPrice(item: Pick<PriceListItem, "pricingModel" | "priceSen" | "extraUnitPriceSen">, unitPriceSen: number | null): boolean {
  if (unitPriceSen === null) return false;
  return unitPriceSen === item.priceSen || (item.pricingModel === "base_plus_units" && unitPriceSen === item.extraUnitPriceSen);
}

// ---------- Ready to finalise? ----------

/** Used when Quinn can't find the client's or project's name. Can be saved, never finalised. */
export const PLACEHOLDER_CLIENT = "Client to be confirmed";
export const PLACEHOLDER_TITLE = "Project title to be confirmed";

export interface ReviewInput {
  quoteDate: string | null;
  validUntil: string | null;
  clientCompany: string;
  projectTitle: string;
  overview: string | null;
  scopeCount: number; // services + features + deliverables
  lines: { description: string; quantity: number; unitPriceSen: number | null }[];
  discount: Discount;
  subtotalSen: number;
  totalSen: number;
  paymentMilestones: PaymentMilestone[];
  termsText: string | null;
}

/**
 * Errors block finalising. Warnings are shown before finalising so suspicious values
 * (placeholder prices, an old date, a one-day validity) get a second look.
 */
export function reviewQuote(r: ReviewInput, today = todayKL()): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (r.clientCompany.trim().length < 2 || r.clientCompany.trim().toLowerCase() === PLACEHOLDER_CLIENT.toLowerCase()) errors.push("Enter the client's company name.");
  if (r.projectTitle.trim().length < 3 || r.projectTitle.trim().toLowerCase() === PLACEHOLDER_TITLE.toLowerCase()) errors.push("Enter a project title.");
  if (!r.quoteDate) errors.push("Enter the quotation date.");
  if (!r.validUntil) errors.push("Enter the validity date.");
  else if (r.quoteDate && r.validUntil < r.quoteDate) errors.push("The validity date is before the quotation date.");
  if (r.lines.length === 0) errors.push("Add at least one pricing item.");
  const unpriced = r.lines.filter((l) => l.unitPriceSen === null);
  if (unpriced.length) {
    errors.push(`Price review required: enter a unit price for ${unpriced.length === 1 ? `"${unpriced[0].description}"` : `${unpriced.length} items`}.`);
  }
  if (r.discount && r.discount.type === "amount" && r.discount.value > r.subtotalSen) errors.push("The discount is larger than the subtotal.");
  if (r.paymentMilestones.length === 0) errors.push("Add the payment terms (at least one payment).");
  else {
    const sum = r.paymentMilestones.reduce((s, m) => s + m.percentBp, 0);
    if (sum !== 10000) errors.push(`Payment terms add up to ${sum / 100}%. They must add up to 100%.`);
  }

  if (!r.overview?.trim()) warnings.push("There's no project overview.");
  if (r.scopeCount === 0) warnings.push("The scope of work is empty (no services, features or deliverables).");
  if (!r.termsText?.trim()) warnings.push("There are no terms & conditions.");
  else if (r.termsText.trim().length < 40) warnings.push("The terms & conditions are very short. Check they aren't placeholder text.");
  const tiny = r.lines.filter((l) => l.unitPriceSen !== null && l.unitPriceSen <= 1000);
  if (tiny.length) warnings.push(`${tiny.length === 1 ? `"${tiny[0].description}" is` : `${tiny.length} items are`} priced at RM 10.00 or less. Check this isn't a placeholder.`);
  if (r.lines.length > 0 && unpriced.length === 0 && r.totalSen === 0) warnings.push("The total is RM 0.00.");
  if (r.quoteDate && r.quoteDate < today) warnings.push("The quotation date is in the past. Update it if you're sending this today.");
  if (r.quoteDate && r.validUntil && r.validUntil >= r.quoteDate && daysBetween(r.quoteDate, r.validUntil) < 7) {
    warnings.push("The quotation is valid for less than a week.");
  }
  return { errors, warnings };
}
