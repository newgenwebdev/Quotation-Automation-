/** Pure maths, parsing and checks shared by the editor (browser) and the server. No database. */
import { describe, it, expect } from "vitest";
import {
  computeTotals, linesFromPriceList, parsePercent, parseRinggit, percentOf, quantityText, reviewQuote, splitMilestones, validUnitLabel,
  type PriceListItem, type ReviewInput,
} from "@/quotations/calc";
import { blankState, liveTotals, stateFromSaved, toPayload } from "@/web/editor/model";
import type { Quotation, QuotationLine, QuotationVersion } from "@/db/schema";

const item = (over: Partial<PriceListItem>): PriceListItem => ({
  id: "i1", code: "X", version: 1, name: "Item", category: "website", pricingModel: "fixed", priceSen: 100_000,
  includedUnits: null, extraUnitPriceSen: null, unitLabel: null, minQuantity: 1, maxQuantity: 1, ...over,
});

describe("Money and percentages", () => {
  it("parses ringgit exactly, without floating-point errors", () => {
    expect(parseRinggit("5,899.50")).toBe(589_950);
    expect(parseRinggit("RM 0.1")).toBe(10);
    expect(parseRinggit("0.29")).toBe(29);
    expect(parseRinggit("")).toBeNull();
    expect(parseRinggit("12.345")).toBeNaN();
    expect(parseRinggit("-5")).toBeNaN();
    expect(parseRinggit("abc")).toBeNaN();
  });

  it("parses percentages", () => {
    expect(parsePercent("8")).toBe(800);
    expect(parsePercent("7.5%")).toBe(750);
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("1.234")).toBeNaN();
  });

  it("rounds half-up to the sen", () => {
    expect(percentOf(1, 5000)).toBe(1); // 0.5 sen → 1
    expect(percentOf(346_911, 1000)).toBe(34_691);
  });

  it("totals: discount before tax, discount capped at the subtotal, nothing negative", () => {
    expect(computeTotals([{ lineTotalSen: 100_000 }, { lineTotalSen: null }], { type: "amount", value: 10_000, label: null }, { label: "SST", rateBp: 800 }))
      .toEqual({ subtotalSen: 100_000, discountSen: 10_000, taxSen: 7_200, totalSen: 97_200 });
    expect(computeTotals([{ lineTotalSen: 5_000 }], { type: "amount", value: 9_000, label: null }, null).totalSen).toBe(0);
  });

  it("milestones always reconcile", () => {
    const parts = splitMilestones(10_001, [{ label: "a", percentBp: 3333 }, { label: "b", percentBp: 3333 }, { label: "c", percentBp: 3334 }]);
    expect(parts.map((p) => p.amountSen)).toEqual([3_333, 3_333, 3_335]);
  });
});

describe("Units", () => {
  it("shows the unit only when it's a word, and pluralises simple words", () => {
    expect(quantityText(7, "page")).toBe("7 pages");
    expect(quantityText(1, "month")).toBe("1 month");
    expect(quantityText(3, "hours")).toBe("3 hours");
    expect(quantityText(2, null)).toBe("2");
    expect(validUnitLabel("20")).toBe(false); // the "1 20" bug
    expect(validUnitLabel("man-day")).toBe(true);
  });
});

describe("Price list → pricing lines", () => {
  it("fixed packages are quantity 1 only", () => {
    expect(linesFromPriceList(item({}), 1)).toMatchObject({ lines: [{ quantity: 1, unitPriceSen: 100_000 }] });
    expect(linesFromPriceList(item({}), 2)).toHaveProperty("problem");
  });

  it("per-unit items respect min and max", () => {
    const i = item({ pricingModel: "per_unit", unitLabel: "page", maxQuantity: 5, minQuantity: 2, priceSen: 20_000 });
    expect(linesFromPriceList(i, 3)).toMatchObject({ lines: [{ quantity: 3, unitLabel: "page", unitPriceSen: 20_000 }] });
    expect(linesFromPriceList(i, 1)).toMatchObject({ problem: expect.stringContaining("starts at 2 pages") });
    expect(linesFromPriceList(i, 6)).toMatchObject({ problem: expect.stringContaining("covers up to 5 pages") });
  });

  it("package + extra units becomes two visible lines", () => {
    const i = item({ pricingModel: "base_plus_units", unitLabel: "page", includedUnits: 5, extraUnitPriceSen: 50_000, priceSen: 500_000, maxQuantity: 10 });
    expect(linesFromPriceList(i, 4)).toMatchObject({ lines: [{ quantity: 1, unitPriceSen: 500_000, details: "Includes up to 5 pages" }] });
    const r = linesFromPriceList(i, 7);
    expect("lines" in r && r.lines.map((l) => [l.description, l.quantity, l.unitPriceSen])).toEqual([["Item", 1, 500_000], ["Additional pages", 2, 50_000]]);
  });
});

describe("Ready to finalise?", () => {
  const ok: ReviewInput = {
    quoteDate: "2026-11-03", validUntil: "2026-12-03", clientCompany: "Acme Sdn Bhd", projectTitle: "Website", overview: "Overview",
    scopeCount: 3, lines: [{ description: "Design", quantity: 1, unitPriceSen: 500_000 }], discount: null, subtotalSen: 500_000, totalSen: 500_000,
    paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Balance", percentBp: 5000 }], termsText: "1. A proper clause that is long enough to be real terms.",
  };

  it("passes a complete quotation", () => {
    expect(reviewQuote(ok, "2026-11-03")).toEqual({ errors: [], warnings: [] });
  });

  it("blocks unpriced items, wrong payment totals, bad dates and placeholder names", () => {
    const r = reviewQuote({ ...ok, clientCompany: "Client to be confirmed", lines: [{ description: "SAP", quantity: 1, unitPriceSen: null }], paymentMilestones: [{ label: "Deposit", percentBp: 4000 }], validUntil: "2026-11-01" }, "2026-11-03");
    expect(r.errors).toEqual(expect.arrayContaining([
      "Enter the client's company name.", 'Price review required: enter a unit price for "SAP".',
      "Payment terms add up to 40%. They must add up to 100%.", "The validity date is before the quotation date.",
    ]));
  });

  it("warns about suspicious values (placeholder prices, short validity, empty or 'testing' T&C, old date)", () => {
    const r = reviewQuote({ ...ok, lines: [{ description: "Testing", quantity: 1, unitPriceSen: 100 }], validUntil: "2026-11-04", termsText: "testing", quoteDate: "2026-11-03" }, "2026-11-10");
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/RM 10.00 or less/);
    expect(r.warnings.join(" ")).toMatch(/less than a week/);
    expect(r.warnings.join(" ")).toMatch(/very short/);
    expect(r.warnings.join(" ")).toMatch(/in the past/);
  });
});

describe("Editor form ↔ saved quotation", () => {
  const defaults = { quoteDate: "2026-11-03", validUntil: "2026-12-03", paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Balance", percentBp: 5000 }], tax: null, terms: { templateId: null, text: "T&C" } };

  it("a blank manual quotation starts with the default payment terms and T&C", () => {
    const s = blankState(defaults);
    expect(s.paymentMilestones.map((m) => [m.label, m.percent])).toEqual([["Deposit", "50"], ["Balance", "50"]]);
    expect(s.termsText).toBe("T&C");
    expect(s.lines).toHaveLength(1);
  });

  it("flags badly typed numbers per field instead of saving them", () => {
    const s = blankState(defaults);
    s.client.company = "Acme"; s.projectTitle = "Website";
    s.lines = [{ ...s.lines[0], description: "Design", quantity: "two", unitPrice: "12.345", unitLabel: "20" }];
    const { errors } = toPayload(s);
    expect(Object.keys(errors).sort()).toEqual([`line.${s.lines[0].key}.quantity`, `line.${s.lines[0].key}.unitLabel`, `line.${s.lines[0].key}.unitPrice`].sort());
  });

  it("live totals match the server maths", () => {
    const s = blankState(defaults);
    s.lines = [{ ...s.lines[0], description: "A", quantity: "2", unitPrice: "1,234.56" }];
    s.discountType = "percent"; s.discountValue = "10"; s.taxEnabled = true; s.taxLabel = "SST"; s.taxRate = "8";
    expect(liveTotals(s).totals).toEqual(computeTotals([{ lineTotalSen: 246_912 }], { type: "percent", value: 1000, label: null }, { label: "SST", rateBp: 800 }));
  });

  it("old price-list lines without a unit price open as one priced line, keeping the amount", () => {
    const q = { id: "q", number: "NGQ-2026-0001", clientCompany: "A", clientContactName: null, clientContactEmail: null, clientContactPhone: null, clientAddress: null, projectTitle: "P", updatedAt: new Date() } as unknown as Quotation;
    const v = { version: 1, quoteDate: null, validUntil: null, scopeSummary: null, objectives: [], services: [], features: [], technicalRequirements: [], deliverables: [], exclusions: [], assumptions: [], discountType: null, discountValue: null, discountLabel: null, taxRateBp: null, taxLabel: null, timelineDuration: null, timelineMilestones: [], paymentMilestones: [], paymentNotes: null, termsTemplateId: null, termsSourceVersionId: null, termsText: null, projectTerms: null, internalNotes: null } as unknown as QuotationVersion;
    const legacy = { catalogueItemId: "c", category: null, description: "Website", details: null, quantity: 7, unitLabel: "page", unitPriceSen: null, lineTotalSen: 600_001 } as unknown as QuotationLine;
    const s = stateFromSaved(q, v, [legacy], defaults);
    expect(s.lines[0]).toMatchObject({ quantity: "1", unitPrice: "6000.01", details: "7 page" });
    expect(liveTotals(s).totals.subtotalSen).toBe(600_001);
  });
});
