/** TEST DATA ONLY — fictional prices, not NewGen's real catalogue. */
import type { CatalogueItem, CommercialPolicy } from "@/db/schema";

const base = {
  currency: "MYR", minQuantity: 1, maxQuantity: 1, includedUnits: null, extraUnitPriceSen: null,
  unitLabel: null, inclusions: [], exclusions: [], revisionLimit: null, technicalReviewConditions: [],
  alwaysRequiresTechnicalReview: false, validFrom: "2026-01-01", validTo: null,
  status: "approved" as const, createdBy: "u-fin", approvedBy: "u-admin", approvedAt: new Date("2026-01-01"),
  supersedesId: null, notes: null, createdAt: new Date("2026-01-01"), version: 1,
};

export function item(over: Partial<CatalogueItem> & Pick<CatalogueItem, "code">): CatalogueItem {
  return {
    id: `id-${over.code}-${over.version ?? 1}`, name: over.code, category: "website", kind: "package",
    pricingModel: "fixed", priceSen: 100_000, ...base, ...over,
  } as CatalogueItem;
}

export const WEB_TEMPLATE = item({
  code: "WEB-TEMPLATE", name: "Template Website", pricingModel: "base_plus_units",
  priceSen: 500_000, includedUnits: 5, extraUnitPriceSen: 50_000, unitLabel: "page",
  minQuantity: 1, maxQuantity: 10, revisionLimit: 2,
  inclusions: ["Up to 5 pages", "Contact form"], exclusions: ["Copywriting"],
});
export const LANDING_PAGE = item({
  code: "LANDING", name: "Landing Page", pricingModel: "per_unit", priceSen: 200_000,
  unitLabel: "page", minQuantity: 1, maxQuantity: null,
});
export const ADDON_BOOKING = item({
  code: "ADD-BOOKING", name: "Online Booking Module", kind: "add_on", priceSen: 300_000,
});
export const ADDON_PAYMENT = item({
  code: "ADD-PAYMENT", name: "Payment Gateway Integration", kind: "add_on", priceSen: 250_000,
  alwaysRequiresTechnicalReview: true,
});
export const DRAFT_ONLY = item({ code: "ECOM-BASIC", status: "draft", approvedBy: null, approvedAt: null });
export const EXPIRED = item({ code: "SEO-OLD", validFrom: "2025-01-01", validTo: "2025-12-31" });
export const FUTURE = item({ code: "HOSTING-2027", validFrom: "2027-01-01" });

export const CATALOGUE = [WEB_TEMPLATE, LANDING_PAGE, ADDON_BOOKING, ADDON_PAYMENT, DRAFT_ONLY, EXPIRED, FUTURE];

export function policy(over: Partial<CommercialPolicy> = {}): CommercialPolicy {
  return {
    id: "pol-1", code: "DEFAULT", version: 1, currency: "MYR",
    paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "On completion", percentBp: 5000 }],
    quoteValidityDays: 30, taxEnabled: false, taxLabel: null, taxRateBp: null, termsText: null,
    validFrom: "2026-01-01", validTo: null, status: "approved", createdBy: "u-fin", approvedBy: "u-admin",
    approvedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01"), ...over,
  };
}
