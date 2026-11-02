import { describe, it, expect } from "vitest";
import { calculatePrice, type PricingInput } from "@/pricing/engine";
import { CATALOGUE, policy } from "./fixtures";

const ctx = { catalogue: CATALOGUE, policy: policy() };
const input = (over: Partial<PricingInput>): PricingInput => ({
  currency: "MYR", asOf: "2026-11-02", lines: [], requestedByRole: "sales", ...over,
});
const codes = (r: ReturnType<typeof calculatePrice>) => r.issues.map((i) => i.code);

describe("Standard website pricing", () => {
  it("prices a template website within its included pages (Class A)", () => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 4 }] }), ctx);
    expect(r.status).toBe("priced");
    expect(r.projectClass).toBe("A_standard");
    expect(r.totalSen).toBe(500_000);
    expect(r.isFinalPrice).toBe(true);
    expect(r.lines[0].revisionLimit).toBe(2);
    expect(r.lines[0].catalogueVersion).toBe(1);
  });

  it("charges approved extra-page rate above included pages", () => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 7 }] }), ctx);
    expect(r.totalSen).toBe(500_000 + 2 * 50_000);
    expect(r.lines[0].calculation).toContain("2 × RM 500.00");
  });

  it("per-unit landing pages multiply correctly", () => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: "LANDING", quantity: 3 }] }), ctx);
    expect(r.totalSen).toBe(600_000);
  });
});

describe("Package limits and custom scope", () => {
  it("over the package page limit → needs estimate, not a made-up price", () => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 25 }] }), ctx);
    expect(r.status).toBe("needs_estimate");
    expect(r.projectClass).toBe("C_custom");
    expect(r.isFinalPrice).toBe(false);
    expect(r.lines).toHaveLength(0);
    expect(r.estimateRequests[0].description).toContain("limit is 10");
  });

  it("custom automation request → estimate request, no price for it", () => {
    const r = calculatePrice(input({
      lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }],
      customItems: [{ description: "Sync orders into client's SAP Business One" }],
    }), ctx);
    expect(r.status).toBe("needs_estimate");
    expect(r.projectClass).toBe("C_custom");
    expect(r.totalSen).toBe(500_000); // only the approved part is summed
    expect(r.isFinalPrice).toBe(false);
    expect(codes(r)).toContain("CUSTOM_ITEM_NEEDS_ESTIMATE");
  });

  it("package + approved add-on → Class B", () => {
    const r = calculatePrice(input({ lines: [
      { catalogueCode: "WEB-TEMPLATE", quantity: 5 }, { catalogueCode: "ADD-BOOKING", quantity: 1 },
    ] }), ctx);
    expect(r.status).toBe("priced");
    expect(r.projectClass).toBe("B_customisable");
    expect(r.totalSen).toBe(800_000);
  });

  it("add-on flagged for review → needs technical review (still priced)", () => {
    const r = calculatePrice(input({ lines: [
      { catalogueCode: "WEB-TEMPLATE", quantity: 5 }, { catalogueCode: "ADD-PAYMENT", quantity: 1 },
    ] }), ctx);
    expect(r.status).toBe("needs_technical_review");
    expect(codes(r)).toContain("TECHNICAL_REVIEW_REQUIRED");
  });

  it("add-on alone is blocked", () => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: "ADD-BOOKING", quantity: 1 }] }), ctx);
    expect(r.status).toBe("blocked");
    expect(codes(r)).toContain("ADDON_WITHOUT_PACKAGE");
  });
});

describe("Only approved, in-date prices are used", () => {
  it.each([
    ["ECOM-BASIC", "PRICE_NOT_APPROVED"],
    ["SEO-OLD", "PRICE_EXPIRED"],
    ["HOSTING-2027", "PRICE_NOT_YET_VALID"],
    ["MADE-UP-CODE", "ITEM_NOT_FOUND"],
  ])("%s → %s", (code, issue) => {
    const r = calculatePrice(input({ lines: [{ catalogueCode: code, quantity: 1 }] }), ctx);
    expect(r.status).toBe("blocked");
    expect(r.isFinalPrice).toBe(false);
    expect(codes(r)).toContain(issue);
  });

  it("rejects wrong currency, bad quantities and duplicates", () => {
    expect(codes(calculatePrice(input({ currency: "USD", lines: [{ catalogueCode: "LANDING", quantity: 1 }] }), ctx))).toContain("CURRENCY_MISMATCH");
    expect(codes(calculatePrice(input({ lines: [{ catalogueCode: "LANDING", quantity: 0 }] }), ctx))).toContain("INVALID_QUANTITY");
    expect(codes(calculatePrice(input({ lines: [{ catalogueCode: "LANDING", quantity: 1.5 }] }), ctx))).toContain("INVALID_QUANTITY");
    expect(codes(calculatePrice(input({ lines: [
      { catalogueCode: "LANDING", quantity: 1 }, { catalogueCode: "LANDING", quantity: 2 },
    ] }), ctx))).toContain("DUPLICATE_LINE");
  });

  it("blocks when the policy is missing, unapproved or out of date", () => {
    const l = [{ catalogueCode: "LANDING", quantity: 1 }];
    expect(codes(calculatePrice(input({ lines: l }), { catalogue: CATALOGUE, policy: null }))).toContain("POLICY_MISSING");
    expect(codes(calculatePrice(input({ lines: l }), { catalogue: CATALOGUE, policy: policy({ status: "draft", approvedBy: null, approvedAt: null }) }))).toContain("POLICY_NOT_APPROVED");
    expect(codes(calculatePrice(input({ lines: l }), { catalogue: CATALOGUE, policy: policy({ validTo: "2026-06-30" }) }))).toContain("POLICY_NOT_VALID");
  });
});

describe("Discounts", () => {
  const lines = [{ catalogueCode: "WEB-TEMPLATE", quantity: 5 }];

  it("Sales cannot apply a discount", () => {
    const r = calculatePrice(input({ lines, discount: { type: "percent", value: 1000, reason: "Repeat client" } }), ctx);
    expect(r.status).toBe("blocked");
    expect(codes(r)).toContain("DISCOUNT_NOT_AUTHORISED");
    expect(r.discountSen).toBe(0);
  });

  it("Technical cannot apply a discount either", () => {
    const r = calculatePrice(input({ requestedByRole: "technical", lines, discount: { type: "amount", value: 10_000, reason: "Goodwill gesture" } }), ctx);
    expect(codes(r)).toContain("DISCOUNT_NOT_AUTHORISED");
  });

  it("Finance can apply a reasoned 10% discount", () => {
    const r = calculatePrice(input({ requestedByRole: "finance", lines, discount: { type: "percent", value: 1000, reason: "Repeat client, approved by director" } }), ctx);
    expect(r.status).toBe("priced");
    expect(r.discountSen).toBe(50_000);
    expect(r.totalSen).toBe(450_000);
  });

  it("requires a reason and refuses over-100% or over-subtotal discounts", () => {
    expect(codes(calculatePrice(input({ requestedByRole: "finance", lines, discount: { type: "percent", value: 500, reason: "" } }), ctx))).toContain("DISCOUNT_REASON_REQUIRED");
    expect(codes(calculatePrice(input({ requestedByRole: "admin", lines, discount: { type: "percent", value: 15000, reason: "Typo test" } }), ctx))).toContain("DISCOUNT_INVALID");
    expect(codes(calculatePrice(input({ requestedByRole: "admin", lines, discount: { type: "amount", value: 9_999_999, reason: "Typo test" } }), ctx))).toContain("DISCOUNT_INVALID");
  });
});

describe("Tax only when configured", () => {
  const lines = [{ catalogueCode: "LANDING", quantity: 1 }];

  it("no tax line when the policy has tax switched off", () => {
    const r = calculatePrice(input({ lines }), ctx);
    expect(r.tax).toBeNull();
    expect(r.totalSen).toBe(200_000);
  });

  it("adds tax at the policy rate on the discounted amount, rounded to the sen", () => {
    const taxed = { catalogue: CATALOGUE, policy: policy({ taxEnabled: true, taxLabel: "SST", taxRateBp: 800 }) };
    const r = calculatePrice(input({ requestedByRole: "finance", lines: [{ catalogueCode: "LANDING", quantity: 1 }],
      discount: { type: "amount", value: 33_333, reason: "Rounding check" } }), taxed);
    // taxable 166,667 sen × 8% = 13,333.36 → 13,333 sen
    expect(r.taxableSen).toBe(166_667);
    expect(r.tax).toEqual({ label: "SST", rateBp: 800, amountSen: 13_333 });
    expect(r.totalSen).toBe(180_000);
  });
});

it("is deterministic: same input gives identical output", () => {
  const i = input({ lines: [{ catalogueCode: "WEB-TEMPLATE", quantity: 8 }, { catalogueCode: "ADD-BOOKING", quantity: 1 }] });
  expect(calculatePrice(i, ctx)).toEqual(calculatePrice(i, ctx));
});
