/**
 * DETERMINISTIC PRICING ENGINE
 *
 * The ONLY place in the system that calculates quotation money.
 * The AI (Quinn) may suggest WHICH catalogue items fit a client's needs,
 * but it never produces a number. Same input → same output, every time.
 *
 * Rules, in plain English:
 *  - A price is used only if finance APPROVED it and it is VALID on the quote date.
 *  - Quantities must be inside the package's approved limits.
 *  - Add-ons can only be sold together with a package.
 *  - Anything without an approved price becomes an ESTIMATE REQUEST, never a guess.
 *  - Discounts are only accepted from Finance/Admin, and need a written reason.
 *  - Tax is added only if an approved policy switches it on.
 *  - All maths is in whole sen (RM 1 = 100 sen), so there are no rounding errors.
 *
 * This file has no database access, which makes it easy to test exhaustively.
 */
import type { CatalogueItem, CommercialPolicy, Role } from "@/db/schema";

// ---------- Inputs ----------

export interface PriceLineRequest {
  catalogueCode: string;
  quantity: number;
}

export interface CustomItemRequest {
  /** What the client wants that has no approved price, e.g. "Integrate with SAP B1 inventory". */
  description: string;
}

export interface DiscountRequest {
  type: "percent" | "amount";
  /** percent: basis points (1000 = 10%). amount: sen. */
  value: number;
  reason: string;
}

export interface PricingInput {
  currency: string;
  /** The quotation date, "YYYY-MM-DD". Prices must be valid on this date. */
  asOf: string;
  lines: PriceLineRequest[];
  customItems?: CustomItemRequest[];
  discount?: DiscountRequest;
  requestedByRole: Role;
}

export interface PricingContext {
  /** Catalogue rows the caller loaded. The engine re-checks approval and dates itself. */
  catalogue: CatalogueItem[];
  policy: CommercialPolicy | null;
}

// ---------- Outputs ----------

export type IssueCode =
  | "ITEM_NOT_FOUND" | "PRICE_NOT_APPROVED" | "PRICE_NOT_YET_VALID" | "PRICE_EXPIRED"
  | "CURRENCY_MISMATCH" | "INVALID_QUANTITY" | "QUANTITY_BELOW_MINIMUM" | "QUANTITY_ABOVE_PACKAGE_LIMIT"
  | "ADDON_WITHOUT_PACKAGE" | "DUPLICATE_LINE" | "NO_ITEMS"
  | "POLICY_MISSING" | "POLICY_NOT_APPROVED" | "POLICY_NOT_VALID"
  | "DISCOUNT_NOT_AUTHORISED" | "DISCOUNT_REASON_REQUIRED" | "DISCOUNT_INVALID"
  | "CUSTOM_ITEM_NEEDS_ESTIMATE" | "TECHNICAL_REVIEW_REQUIRED";

export interface PricingIssue {
  code: IssueCode;
  /** blocking = no final price can be issued until fixed. */
  severity: "blocking" | "needs_estimate" | "needs_review";
  message: string;
  catalogueCode?: string;
}

export interface PricedLine {
  catalogueItemId: string;
  catalogueCode: string;
  catalogueVersion: number;
  name: string;
  quantity: number;
  unitLabel: string | null;
  /** Human-readable breakdown, e.g. "Base (covers 5 page) + 2 × RM 500.00". */
  calculation: string;
  lineTotalSen: number;
  inclusions: string[];
  exclusions: string[];
  revisionLimit: number | null;
}

export type PricingStatus =
  | "priced"                  // final, ready for finance approval
  | "needs_technical_review"  // priced, but tech team must confirm scope first
  | "needs_estimate"          // contains items with no approved price
  | "blocked";                // something is wrong; no final price allowed

/** A = standard package, B = customisable (add-ons or review), C = custom solution. */
export type ProjectClass = "A_standard" | "B_customisable" | "C_custom";

export interface PricingResult {
  status: PricingStatus;
  projectClass: ProjectClass;
  currency: string;
  lines: PricedLine[];
  estimateRequests: CustomItemRequest[];
  subtotalSen: number;
  discountSen: number;
  taxableSen: number;
  tax: { label: string; rateBp: number; amountSen: number } | null;
  totalSen: number;
  /** false whenever status is not "priced" or "needs_technical_review". */
  isFinalPrice: boolean;
  issues: PricingIssue[];
  policyId: string | null;
  policyVersion: number | null;
}

const DISCOUNT_ROLES: Role[] = ["finance", "admin"];

// ---------- Helpers ----------

/** Round half-up on whole sen. Used only for percentages. */
export function percentOf(amountSen: number, bp: number): number {
  // amount * bp / 10000, rounded half-up, using integer maths.
  return Math.floor((amountSen * bp + 5000) / 10000);
}

function safe(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new Error(`Amount overflow in ${what}`);
  return n;
}

export function formatSen(sen: number, currency = "MYR"): string {
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  const ringgit = Math.floor(abs / 100).toLocaleString("en-MY");
  const cents = String(abs % 100).padStart(2, "0");
  const symbol = currency === "MYR" ? "RM" : currency;
  return `${sign}${symbol} ${ringgit}.${cents}`;
}

function isValidOn(from: string, to: string | null, day: string): "ok" | "not_yet" | "expired" {
  if (day < from) return "not_yet";
  if (to !== null && day > to) return "expired";
  return "ok";
}

// ---------- The engine ----------

export function calculatePrice(input: PricingInput, ctx: PricingContext): PricingResult {
  const issues: PricingIssue[] = [];
  const lines: PricedLine[] = [];
  const currency = input.currency;
  const customItems = (input.customItems ?? []).filter((c) => c.description.trim() !== "");

  if (input.lines.length === 0 && customItems.length === 0) {
    issues.push({ code: "NO_ITEMS", severity: "blocking", message: "Nothing to price." });
  }

  // Policy: needed for tax, payment terms and validity. Must be approved and in force.
  const policy = ctx.policy;
  if (!policy) {
    issues.push({ code: "POLICY_MISSING", severity: "blocking", message: "No commercial policy has been set up by finance." });
  } else if (policy.status !== "approved") {
    issues.push({ code: "POLICY_NOT_APPROVED", severity: "blocking", message: "The commercial policy is not approved by finance." });
  } else if (isValidOn(policy.validFrom, policy.validTo, input.asOf) !== "ok") {
    issues.push({ code: "POLICY_NOT_VALID", severity: "blocking", message: "The commercial policy is not valid on the quotation date." });
  } else if (policy.currency !== currency) {
    issues.push({ code: "CURRENCY_MISMATCH", severity: "blocking", message: `Policy currency ${policy.currency} does not match quotation currency ${currency}.` });
  }

  // Price each requested catalogue line.
  const seen = new Set<string>();
  let hasPackage = false;
  let hasAddOn = false;
  let needsReview = false;

  for (const req of input.lines) {
    const code = req.catalogueCode;
    if (seen.has(code)) {
      issues.push({ code: "DUPLICATE_LINE", severity: "blocking", catalogueCode: code, message: `${code} appears more than once; combine into one line with a quantity.` });
      continue;
    }
    seen.add(code);

    if (!Number.isInteger(req.quantity) || req.quantity < 1) {
      issues.push({ code: "INVALID_QUANTITY", severity: "blocking", catalogueCode: code, message: `Quantity for ${code} must be a whole number of at least 1.` });
      continue;
    }

    // Find the version that is approved — never fall back to a draft.
    const versions = ctx.catalogue.filter((c) => c.code === code);
    if (versions.length === 0) {
      issues.push({ code: "ITEM_NOT_FOUND", severity: "blocking", catalogueCode: code, message: `${code} is not in the price catalogue.` });
      continue;
    }
    const item = versions.find((v) => v.status === "approved");
    if (!item) {
      issues.push({ code: "PRICE_NOT_APPROVED", severity: "blocking", catalogueCode: code, message: `${code} has no finance-approved price.` });
      continue;
    }
    const validity = isValidOn(item.validFrom, item.validTo, input.asOf);
    if (validity !== "ok") {
      issues.push({
        code: validity === "expired" ? "PRICE_EXPIRED" : "PRICE_NOT_YET_VALID",
        severity: "blocking", catalogueCode: code,
        message: validity === "expired" ? `The approved price for ${code} expired on ${item.validTo}.` : `The approved price for ${code} only starts on ${item.validFrom}.`,
      });
      continue;
    }
    if (item.currency !== currency) {
      issues.push({ code: "CURRENCY_MISMATCH", severity: "blocking", catalogueCode: code, message: `${code} is priced in ${item.currency}, not ${currency}.` });
      continue;
    }
    if (req.quantity < item.minQuantity) {
      issues.push({ code: "QUANTITY_BELOW_MINIMUM", severity: "blocking", catalogueCode: code, message: `${code} requires at least ${item.minQuantity} ${item.unitLabel ?? "unit"}(s).` });
      continue;
    }
    if (item.maxQuantity !== null && req.quantity > item.maxQuantity) {
      // Outside the approved package — this is no longer a standard quote.
      issues.push({
        code: "QUANTITY_ABOVE_PACKAGE_LIMIT", severity: "needs_estimate", catalogueCode: code,
        message: `${code} allows at most ${item.maxQuantity} ${item.unitLabel ?? "unit"}(s); ${req.quantity} requested. The excess needs a technical estimate.`,
      });
      customItems.push({ description: `${item.name}: ${req.quantity} ${item.unitLabel ?? "units"} requested, approved package limit is ${item.maxQuantity}` });
      continue;
    }

    let lineTotalSen: number;
    let calculation: string;
    switch (item.pricingModel) {
      case "fixed":
        lineTotalSen = item.priceSen;
        calculation = `Fixed price ${formatSen(item.priceSen, currency)}`;
        break;
      case "per_unit":
        lineTotalSen = safe(item.priceSen * req.quantity, code);
        calculation = `${req.quantity} × ${formatSen(item.priceSen, currency)}`;
        break;
      case "base_plus_units": {
        const included = item.includedUnits ?? 0;
        const extra = Math.max(0, req.quantity - included);
        lineTotalSen = safe(item.priceSen + extra * (item.extraUnitPriceSen ?? 0), code);
        calculation = extra === 0
          ? `Base price (covers up to ${included} ${item.unitLabel ?? "units"})`
          : `Base price (covers ${included} ${item.unitLabel ?? "units"}) + ${extra} × ${formatSen(item.extraUnitPriceSen ?? 0, currency)}`;
        break;
      }
    }

    if (item.kind === "package") hasPackage = true;
    else hasAddOn = true;

    if (item.alwaysRequiresTechnicalReview) {
      needsReview = true;
      issues.push({ code: "TECHNICAL_REVIEW_REQUIRED", severity: "needs_review", catalogueCode: code, message: `${item.name} always requires technical review before finance approval.` });
    }

    lines.push({
      catalogueItemId: item.id, catalogueCode: code, catalogueVersion: item.version, name: item.name,
      quantity: req.quantity, unitLabel: item.unitLabel, calculation, lineTotalSen,
      inclusions: item.inclusions, exclusions: item.exclusions, revisionLimit: item.revisionLimit,
    });
  }

  if (hasAddOn && !hasPackage) {
    issues.push({ code: "ADDON_WITHOUT_PACKAGE", severity: "blocking", message: "Add-ons can only be quoted together with a base package." });
  }

  for (const c of customItems) {
    issues.push({ code: "CUSTOM_ITEM_NEEDS_ESTIMATE", severity: "needs_estimate", message: `No approved price for: "${c.description}". A technical estimate is required.` });
  }

  const subtotalSen = safe(lines.reduce((s, l) => s + l.lineTotalSen, 0), "subtotal");

  // Discount: Finance/Admin only, written reason, never more than the subtotal.
  let discountSen = 0;
  if (input.discount) {
    const d = input.discount;
    if (!DISCOUNT_ROLES.includes(input.requestedByRole)) {
      issues.push({ code: "DISCOUNT_NOT_AUTHORISED", severity: "blocking", message: `Only Finance or Admin can apply discounts (requested by ${input.requestedByRole}).` });
    } else if (!d.reason || d.reason.trim().length < 5) {
      issues.push({ code: "DISCOUNT_REASON_REQUIRED", severity: "blocking", message: "A discount needs a written reason for the audit trail." });
    } else if (!Number.isInteger(d.value) || d.value <= 0
      || (d.type === "percent" && d.value > 10000)
      || (d.type === "amount" && d.value > subtotalSen)) {
      issues.push({ code: "DISCOUNT_INVALID", severity: "blocking", message: "Discount must be a positive whole number and cannot exceed 100% or the subtotal." });
    } else {
      discountSen = d.type === "percent" ? percentOf(subtotalSen, d.value) : d.value;
    }
  }

  const taxableSen = subtotalSen - discountSen;
  let tax: PricingResult["tax"] = null;
  const policyUsable = policy && policy.status === "approved" && !issues.some((i) => i.code.startsWith("POLICY_"));
  if (policyUsable && policy.taxEnabled && policy.taxRateBp !== null && policy.taxLabel) {
    tax = { label: policy.taxLabel, rateBp: policy.taxRateBp, amountSen: percentOf(taxableSen, policy.taxRateBp) };
  }
  const totalSen = safe(taxableSen + (tax?.amountSen ?? 0), "total");

  // Decide the overall status. Worst problem wins.
  const status: PricingStatus =
    issues.some((i) => i.severity === "blocking") ? "blocked"
    : issues.some((i) => i.severity === "needs_estimate") ? "needs_estimate"
    : needsReview ? "needs_technical_review"
    : "priced";

  const projectClass: ProjectClass =
    customItems.length > 0 ? "C_custom"
    : hasAddOn || needsReview ? "B_customisable"
    : "A_standard";

  return {
    status, projectClass, currency, lines,
    estimateRequests: customItems,
    subtotalSen, discountSen, taxableSen, tax, totalSen,
    isFinalPrice: status === "priced" || status === "needs_technical_review",
    issues,
    policyId: policyUsable ? policy.id : null,
    policyVersion: policyUsable ? policy.version : null,
  };
}
