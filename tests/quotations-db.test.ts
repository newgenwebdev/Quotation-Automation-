/**
 * Quotations against a REAL PostgreSQL test database: the shared editor's save, calculations,
 * finalising, sent, edit (revision), duplicate, cancel, numbering, search and the PDF.
 * Covers QA scenarios 7–16.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type DB } from "@/db/client";
import { users, quotationLines, quotationVersions, quotations, auditLog, type CatalogueItem } from "@/db/schema";
import type { Actor } from "@/auth/permissions";
import { saveCatalogueItem, savePolicy } from "@/catalogue/service";
import { createTemplate } from "@/terms/service";
import { loadCompany } from "@/company/service";
import {
  saveDraft, finaliseQuotation, markSent, reviseQuotation, duplicateQuotation, cancelQuotation, loadQuote, listQuotations,
  newQuoteDefaults, previousTermsFor, type QuotePayloadInput,
} from "@/quotations/service";
import { addDays, splitMilestones, todayKL } from "@/quotations/calc";
import { renderQuotationPdf } from "@/quotations/pdf";

const url = process.env.TEST_DATABASE_URL!;
let db: DB; let pool: import("pg").Pool;
let sally: Actor; let sam: Actor;
let web: CatalogueItem;
const TERMS = "1. TEST CLAUSE: a 50% deposit is payable before work starts.\n2. TEST CLAUSE: two revision rounds are included.";

beforeAll(async () => { ({ db, pool } = createDb(url)); await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await db.execute(sql`TRUNCATE agent_events, agent_tasks, audit_log, quotation_lines, quotation_versions, quotations, terms_templates, catalogue_items, commercial_policies, users RESTART IDENTITY CASCADE`);
  const [a, b] = await db.insert(users).values([{ email: "s@t.local", name: "Sally Tan" }, { email: "s2@t.local", name: "Sam Lee" }]).returning();
  sally = { id: a.id, role: a.role, email: a.email };
  sam = { id: b.id, role: b.role, email: b.email };
  web = await saveCatalogueItem(db, sally, {
    code: "WEB-TEST", name: "Corporate Website (TEST)", category: "website", kind: "package", pricingModel: "base_plus_units",
    priceSen: 500_000, includedUnits: 5, extraUnitPriceSen: 50_000, unitLabel: "page", maxQuantity: 10, validFrom: "2026-01-01",
  });
});

const today = todayKL();
function payload(over: Partial<QuotePayloadInput> = {}): QuotePayloadInput {
  return {
    quoteDate: today, validUntil: addDays(today, 30),
    client: { company: "Demo Trading Sdn Bhd (TEST)", contactName: "Mr Lim", email: "lim@demo.test", phone: "012-000 0000", address: "Lot 1, Jalan Test\n70300 Seremban" },
    projectTitle: "Corporate website revamp",
    overview: "Demo Trading needs a faster, mobile-friendly website that brings in enquiries.",
    objectives: ["Increase online enquiries"], services: ["UI/UX design", "Website development"],
    features: ["Enquiry form", "Product catalogue"], technicalRequirements: ["Hosted on the client's cPanel"],
    deliverables: ["7-page responsive website", "Admin training"], exclusions: ["Copywriting"], assumptions: ["Client provides all photos"],
    lines: [
      { catalogueItemId: web.id, description: "Corporate Website (TEST)", details: "Includes up to 5 pages", quantity: 1, unitLabel: null, unitPriceSen: 500_000 },
      { catalogueItemId: web.id, description: "Additional pages", quantity: 2, unitLabel: "page", unitPriceSen: 50_000 },
      { description: "Enquiry form linked to Google Sheets", quantity: 1, unitPriceSen: 250_000, category: "ai_automation" },
    ],
    discount: null, tax: null,
    timeline: { duration: "6–8 weeks", milestones: [{ label: "Design approval", timing: "Week 2" }, { label: "Launch", timing: "Week 8" }] },
    payment: { milestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Before launch", percentBp: 3000 }, { label: "Balance on completion", percentBp: 2000 }], notes: "Payable within 7 days of invoice." },
    terms: { templateId: null, sourceVersionId: null, text: TERMS, projectTerms: "Domain renewal is billed separately." },
    internalNotes: "Client was referred by Eddie. INTERNAL-ONLY-NOTE",
    ...over,
  };
}

describe("Numbering (scenario 16)", () => {
  it("each new quotation gets the next unique, readable number", async () => {
    const a = await saveDraft(db, sally, payload());
    const b = await saveDraft(db, sam, payload({ projectTitle: "Mobile app" }));
    expect(a.quotation.number).toMatch(/^NGQ-\d{4}-\d{4,}$/);
    const n = (x: string) => Number(x.split("-")[2]);
    expect(n(b.quotation.number)).toBe(n(a.quotation.number) + 1);
    await expect(db.update(quotations).set({ number: a.quotation.number }).where(eq(quotations.id, b.quotation.id))).rejects.toThrow();
  });
});

describe("Manual quotation: save and reopen (scenarios 7, 11)", () => {
  it("saves every section and reopens exactly as entered", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.quotation).toMatchObject({ clientCompany: "Demo Trading Sdn Bhd (TEST)", clientContactEmail: "lim@demo.test", clientAddress: "Lot 1, Jalan Test\n70300 Seremban", ownerId: sally.id, status: "draft" });
    expect(b.version).toMatchObject({
      status: "draft", quoteDate: today, validUntil: addDays(today, 30), scopeSummary: expect.stringContaining("mobile-friendly"),
      objectives: ["Increase online enquiries"], services: ["UI/UX design", "Website development"], features: ["Enquiry form", "Product catalogue"],
      technicalRequirements: ["Hosted on the client's cPanel"], deliverables: ["7-page responsive website", "Admin training"], exclusions: ["Copywriting"],
      assumptions: ["Client provides all photos"], timelineDuration: "6–8 weeks", paymentNotes: "Payable within 7 days of invoice.",
      termsText: TERMS, projectTerms: "Domain renewal is billed separately.", internalNotes: expect.stringContaining("INTERNAL-ONLY-NOTE"),
      subtotalSen: 850_000, discountSen: 0, taxSen: 0, totalSen: 850_000,
    });
    expect(b.version.timelineMilestones).toEqual([{ label: "Design approval", timing: "Week 2" }, { label: "Launch", timing: "Week 8" }]);
    expect(b.lines.map((l) => [l.position, l.kind, l.description, l.quantity, l.unitLabel, l.unitPriceSen, l.lineTotalSen])).toEqual([
      [1, "catalogue", "Corporate Website (TEST)", 1, null, 500_000, 500_000],
      [2, "catalogue", "Additional pages", 2, "page", 50_000, 100_000],
      [3, "custom", "Enquiry form linked to Google Sheets", 1, null, 250_000, 250_000],
    ]);
    expect(b.lines[2].category).toBe("ai_automation");
  });

  it("an unfinished draft can be saved (no prices, no payment terms) and finished later", async () => {
    const { quotation } = await saveDraft(db, sally, payload({ lines: [{ description: "Discovery workshop", quantity: 1, unitPriceSen: null }], payment: { milestones: [], notes: null }, validUntil: null }));
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.lines[0]).toMatchObject({ unitPriceSen: null, lineTotalSen: null });
    expect(b.version.validUntil).toBeNull();
  });

  it("adding and removing items replaces the pricing table (scenario 8)", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const p = payload();
    p.lines = [p.lines![2], { description: "Hosting (1 year)", quantity: 1, unitLabel: "year", unitPriceSen: 120_000 }];
    await saveDraft(db, sally, { ...p, baseUpdatedAt: quotation.updatedAt.toISOString() }, { quotationId: quotation.id });
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.lines.map((l) => [l.position, l.description])).toEqual([[1, "Enquiry form linked to Google Sheets"], [2, "Hosting (1 year)"]]);
    expect(b.version.totalSen).toBe(370_000);
    expect((await db.select().from(auditLog).where(eq(auditLog.entityId, quotation.id))).map((r) => r.action)).toEqual(["quote.created", "quote.saved"]);
  });

  it("a line keeps its price-list link only at the listed price; a changed price makes it hand-priced", async () => {
    const p = payload();
    p.lines![0] = { ...p.lines![0], unitPriceSen: 450_000 };
    const { quotation } = await saveDraft(db, sally, p);
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.lines[0]).toMatchObject({ kind: "custom", catalogueItemId: null, unitPriceSen: 450_000 });
    expect(b.lines[1]).toMatchObject({ kind: "catalogue", catalogueCode: "WEB-TEST" });
  });

  it("refuses invalid input with clear messages (scenario 20)", async () => {
    const bad = async (over: Partial<QuotePayloadInput>, msg: RegExp) => expect(saveDraft(db, sally, payload(over))).rejects.toThrow(msg);
    await bad({ client: { company: "" } }, /client's company name/);
    await bad({ projectTitle: "x" }, /project title/);
    await bad({ client: { company: "Acme", email: "not-an-email" } }, /valid client email/);
    await bad({ validUntil: addDays(today, -1) }, /validity date is before/);
    await bad({ lines: [{ description: "Design", quantity: 0, unitPriceSen: 100 }] }, /at least 1/);
    await bad({ lines: [{ description: "Design", quantity: 1, unitPriceSen: -5 }] }, /can't be negative/);
    await bad({ lines: [{ description: "Design", quantity: 1, unitLabel: "20", unitPriceSen: 100 }] }, /must be a word/);
    await bad({ lines: [{ description: "", quantity: 1, unitPriceSen: 100 }] }, /needs a description/);
    await bad({ discount: { type: "percent", value: 12000, label: null } }, /more than 100%/);
  });

  it("two people saving the same draft: the second one is warned instead of overwriting", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const opened = quotation.updatedAt.toISOString();
    await saveDraft(db, sam, { ...payload({ projectTitle: "Sam's change" }), baseUpdatedAt: opened }, { quotationId: quotation.id });
    await expect(saveDraft(db, sally, { ...payload({ projectTitle: "Sally's change" }), baseUpdatedAt: opened }, { quotationId: quotation.id }))
      .rejects.toMatchObject({ code: "STALE" });
    expect((await loadQuote(db, sally, quotation.id))!.quotation.projectTitle).toBe("Sam's change");
  });
});

describe("Calculations (scenarios 9, 10)", () => {
  it("subtotal, percentage discount, tax on the discounted amount, and grand total — all on the server", async () => {
    const { version } = await saveDraft(db, sally, payload({
      lines: [{ description: "A", quantity: 2, unitPriceSen: 123_456 }, { description: "B", quantity: 1, unitPriceSen: 99_999 }],
      discount: { type: "percent", value: 1000, label: "Launch promo" }, tax: { label: "SST", rateBp: 800 },
    }));
    // 2 × 1,234.56 + 999.99 = 3,469.11 · 10% = 346.91 · taxable 3,122.20 · SST 8% = 249.78 · total 3,371.98
    expect(version).toMatchObject({ subtotalSen: 346_911, discountSen: 34_691, taxSen: 24_978, totalSen: 337_198, discountLabel: "Launch promo" });
  });

  it("a fixed discount is never more than the subtotal, and finalising refuses one that is", async () => {
    const { quotation, version } = await saveDraft(db, sally, payload({ lines: [{ description: "A", quantity: 1, unitPriceSen: 10_000 }], discount: { type: "amount", value: 50_000, label: null } }));
    expect(version).toMatchObject({ subtotalSen: 10_000, discountSen: 10_000, totalSen: 0 });
    await expect(finaliseQuotation(db, sally, quotation.id)).rejects.toThrow(/discount is larger than the subtotal/);
  });

  it("payment milestones always add up exactly to the total, even with awkward percentages", () => {
    for (const total of [100_001, 337_198, 1, 999_999_999]) {
      const parts = splitMilestones(total, [{ label: "A", percentBp: 3333 }, { label: "B", percentBp: 3333 }, { label: "C", percentBp: 3334 }]);
      expect(parts.reduce((s, p) => s + p.amountSen, 0)).toBe(total);
    }
    expect(splitMilestones(850_000, [{ label: "Deposit", percentBp: 5000 }, { label: "Before launch", percentBp: 3000 }, { label: "Balance", percentBp: 2000 }]).map((m) => m.amountSen))
      .toEqual([425_000, 255_000, 170_000]);
  });

  it("totals sent from the browser are ignored (the server always recalculates)", async () => {
    const tampered = { ...payload(), subtotalSen: 1, totalSen: 1, lines: [{ description: "A", quantity: 3, unitPriceSen: 1000, lineTotalSen: 1 }] } as unknown as QuotePayloadInput;
    const { version } = await saveDraft(db, sally, tampered);
    expect(version.totalSen).toBe(3000);
  });
});

describe("Finalise, sent, edit, duplicate, cancel (scenarios 12, 13)", () => {
  it("finalises without any approval; the finalised version is then frozen", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const v = await finaliseQuotation(db, sally, quotation.id);
    expect(v).toMatchObject({ status: "finalised", finalisedBy: sally.id });
    expect(v.finalisedAt).toBeInstanceOf(Date);
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.quotation.status).toBe("finalised");
    await expect(saveDraft(db, sally, payload(), { quotationId: quotation.id })).rejects.toMatchObject({ code: "NOT_DRAFT" });
    await expect(db.update(quotationVersions).set({ scopeSummary: "x" }).where(eq(quotationVersions.id, v.id))).rejects.toThrow();
    await expect(db.update(quotationLines).set({ unitPriceSen: 1, lineTotalSen: 1 }).where(eq(quotationLines.versionId, v.id))).rejects.toThrow();
  });

  it("blocks finalising while something required is missing, listing each problem", async () => {
    const { quotation } = await saveDraft(db, sally, payload({
      lines: [{ description: "Custom integration", quantity: 1, unitPriceSen: null }],
      payment: { milestones: [{ label: "Deposit", percentBp: 5000 }], notes: null }, validUntil: null,
    }));
    await expect(finaliseQuotation(db, sally, quotation.id)).rejects.toSatisfy((e: unknown) => {
      const d = (e as { details?: string[] }).details ?? [];
      return d.some((x) => x.startsWith("Price review required")) && d.includes("Enter the validity date.") && d.some((x) => x.includes("add up to 50%"));
    });
    expect((await loadQuote(db, sally, quotation.id))!.quotation.status).toBe("draft");
  });

  it("can only be marked as sent once finalised", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    await expect(markSent(db, sally, quotation.id)).rejects.toMatchObject({ code: "NOT_FINALISED" });
    await finaliseQuotation(db, sally, quotation.id);
    await markSent(db, sam, quotation.id);
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.quotation.status).toBe("sent");
    expect(b.quotation.sentAt).toBeInstanceOf(Date);
  });

  it("“Edit” on a finalised or sent quotation starts a new draft revision; the finalised one is kept unchanged", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const v1 = await finaliseQuotation(db, sally, quotation.id);
    await markSent(db, sally, quotation.id);
    const v2 = await reviseQuotation(db, sam, quotation.id);
    expect(v2).toMatchObject({ version: 2, status: "draft", createdBy: sam.id, totalSen: v1.totalSen, termsText: TERMS, quoteDate: today });
    const b = (await loadQuote(db, sally, quotation.id))!;
    expect(b.quotation).toMatchObject({ status: "draft", currentVersion: 2, sentAt: null, ownerId: sally.id });
    expect(b.lines).toHaveLength(3);
    const old = (await loadQuote(db, sally, quotation.id, 1))!;
    expect(old.version).toMatchObject({ status: "finalised", totalSen: 850_000 });
    expect(old.lines).toHaveLength(3);
  });

  it("duplicate creates a new quotation (new number, created by you, dated today) and leaves the original alone", async () => {
    const { quotation } = await saveDraft(db, sally, payload({ quoteDate: addDays(today, -40), validUntil: addDays(today, -10) }));
    await finaliseQuotation(db, sally, quotation.id);
    const copy = await duplicateQuotation(db, sam, quotation.id);
    expect(copy.number).not.toBe(quotation.number);
    const b = (await loadQuote(db, sam, copy.id))!;
    expect(b.quotation).toMatchObject({ ownerId: sam.id, status: "draft", clientCompany: quotation.clientCompany, clientAddress: quotation.clientAddress });
    expect(b.version).toMatchObject({ version: 1, status: "draft", quoteDate: today, validUntil: addDays(today, 30), totalSen: 850_000, aiNotes: null });
    expect(b.lines.map((l) => l.description)).toEqual(["Corporate Website (TEST)", "Additional pages", "Enquiry form linked to Google Sheets"]);
    expect((await loadQuote(db, sally, quotation.id))!.quotation.status).toBe("finalised");
  });

  it("cancel: a draft version is cancelled; a finalised version stays as a record", async () => {
    const a = await saveDraft(db, sally, payload());
    await cancelQuotation(db, sally, a.quotation.id, "Client went elsewhere");
    expect((await loadQuote(db, sally, a.quotation.id))!.version.status).toBe("cancelled");
    await expect(saveDraft(db, sally, payload(), { quotationId: a.quotation.id })).rejects.toMatchObject({ code: "CANCELLED" });
    const b = await saveDraft(db, sally, payload());
    await finaliseQuotation(db, sally, b.quotation.id);
    await cancelQuotation(db, sally, b.quotation.id, null);
    const lb = (await loadQuote(db, sally, b.quotation.id))!;
    expect([lb.quotation.status, lb.version.status]).toEqual(["cancelled", "finalised"]);
  });
});

describe("Defaults, history and search", () => {
  it("new quotations get the payment terms, tax, validity and default T&C from Settings", async () => {
    await savePolicy(db, sally, { paymentMilestones: [{ label: "Deposit", percentBp: 6000 }, { label: "Balance", percentBp: 4000 }], quoteValidityDays: 14, validFrom: "2026-01-01", taxEnabled: true, taxLabel: "SST", taxRateBp: 800 });
    const t = await createTemplate(db, sally, { name: "Standard (TEST)", body: TERMS, isDefault: true });
    const d = await newQuoteDefaults(db);
    expect(d).toMatchObject({ quoteDate: today, validUntil: addDays(today, 14), tax: { label: "SST", rateBp: 800 }, terms: { templateId: t.id, text: TERMS } });
    expect(d.paymentMilestones).toHaveLength(2);
  });

  it("with nothing in Settings, nothing is made up", async () => {
    const d = await newQuoteDefaults(db);
    expect(d).toMatchObject({ paymentMilestones: [], tax: null, terms: { templateId: null, text: null } });
  });

  it("offers this client's earlier finalised T&C for reuse", async () => {
    const a = await saveDraft(db, sally, payload());
    await finaliseQuotation(db, sally, a.quotation.id);
    const prev = await previousTermsFor(db, sam, "demo trading sdn. bhd. (test)");
    expect(prev.map((p) => p.termsText)).toEqual([TERMS]);
  });

  it("lists with search, status filter, creator and totals", async () => {
    const a = await saveDraft(db, sally, payload());
    await saveDraft(db, sam, payload({ client: { company: "Other Co Sdn Bhd" }, projectTitle: "Mobile ordering app" }));
    await finaliseQuotation(db, sally, a.quotation.id);
    expect((await listQuotations(db, sam)).map((r) => r.createdBy).sort()).toEqual(["Sally Tan", "Sam Lee"]);
    expect((await listQuotations(db, sam, { search: "mobile" })).map((r) => r.projectTitle)).toEqual(["Mobile ordering app"]);
    expect((await listQuotations(db, sam, { search: a.quotation.number })).map((r) => r.id)).toEqual([a.quotation.id]);
    expect((await listQuotations(db, sam, { status: "finalised" })).map((r) => [r.status, r.totalSen])).toEqual([["finalised", 850_000]]);
    expect(await listQuotations(db, sam, { search: "%" })).toHaveLength(0); // wildcards are treated as text
  });
});

describe("PDF (scenarios 14, 15)", () => {
  const pdfText = (buf: Buffer) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pdf-"));
    const f = path.join(dir, "q.pdf");
    writeFileSync(f, buf);
    return {
      text: execFileSync("pdftotext", ["-layout", f, "-"]).toString(),
      raw: execFileSync("pdftotext", ["-raw", f, "-"]).toString(), // keeps rotated watermark text together
      pages: Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [f]).toString())![1]),
    };
  };

  it("a finalised quotation prints every section, the right numbers, and nothing internal", async () => {
    const { quotation } = await saveDraft(db, sally, payload({ tax: { label: "SST", rateBp: 800 }, discount: { type: "amount", value: 50_000, label: "Loyalty discount" } }));
    await finaliseQuotation(db, sally, quotation.id);
    const b = (await loadQuote(db, sally, quotation.id))!;
    const { text, raw } = pdfText(await renderQuotationPdf(b, { company: await loadCompany(db), preparedByName: "Sally Tan" }));
    for (const s of [
      "NewGen Innovation Sdn. Bhd.", "202201030615 (1476312T)", quotation.number, "Demo Trading Sdn Bhd (TEST)", "Attn: Mr Lim", "Corporate website revamp",
      "Project Overview", "Objectives", "Scope of Work", "Services included", "Features and functionalities", "Technical requirements", "Deliverables", "Exclusions",
      "Pricing", "Corporate Website (TEST)", "Additional pages", "2 pages", "Subtotal", "RM 8,500.00", "Loyalty discount", "- RM 500.00", "SST (8%)", "RM 640.00", "RM 8,640.00",
      "Project Timeline", "6–8 weeks", "Design approval", "Payment Terms", "Deposit", "RM 4,320.00", "Payable within 7 days of invoice.",
      "Terms & Conditions", "TEST CLAUSE: a 50% deposit", "Project-specific terms", "Domain renewal is billed separately.", "Assumptions", "Client provides all photos",
      "Acceptance", "PREPARED BY", "Sally Tan", "Page 1 of",
    ]) expect(text).toContain(s);
    for (const s of ["INTERNAL-ONLY-NOTE", "Quinn", "DRAFT", "CANCELLED", "Price review", "Finance", "computer-generated", "undefined", "null"]) expect(raw).not.toContain(s);
  });

  it("a draft preview is watermarked DRAFT; a cancelled one CANCELLED", async () => {
    const { quotation } = await saveDraft(db, sally, payload());
    const company = await loadCompany(db);
    expect(pdfText(await renderQuotationPdf((await loadQuote(db, sally, quotation.id))!, { company })).raw).toContain("DRAFT");
    await cancelQuotation(db, sally, quotation.id);
    expect(pdfText(await renderQuotationPdf((await loadQuote(db, sally, quotation.id))!, { company })).raw).toContain("CANCELLED");
  });

  it("a long quotation flows over several pages with the table header repeated and page numbers", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ description: `Feature module ${i + 1}`, details: "Design, build and test this module including documentation and handover to the client team.", quantity: 1 + (i % 3), unitPriceSen: 100_000 + i * 1000 }));
    const longTerms = Array.from({ length: 40 }, (_, i) => `${i + 1}. TEST CLAUSE ${i + 1}: ${"This clause is long enough to wrap across more than one line on an A4 page. ".repeat(2)}`).join("\n");
    const { quotation } = await saveDraft(db, sally, payload({ lines, terms: { text: longTerms, projectTerms: null } }));
    await finaliseQuotation(db, sally, quotation.id);
    const { text, pages } = pdfText(await renderQuotationPdf((await loadQuote(db, sally, quotation.id))!, { company: await loadCompany(db), preparedByName: "Sally Tan" }));
    expect(pages).toBeGreaterThanOrEqual(4);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text.match(/UNIT PRICE/g)!.length).toBeGreaterThanOrEqual(2); // header repeated on the next page
    expect(text).toContain("Feature module 45");
    expect(text).toContain("TEST CLAUSE 40");
  });

  it("characters the PDF fonts can't show (emoji, Chinese) don't break the document", async () => {
    const { quotation } = await saveDraft(db, sally, payload({ projectTitle: "Website 🚀 网站 revamp", overview: "Client said “ASAP” → launch in Q1 ✅" }));
    const { text } = pdfText(await renderQuotationPdf((await loadQuote(db, sally, quotation.id))!, { company: await loadCompany(db) }));
    expect(text).toContain("Website");
    expect(text).toContain('"ASAP" -> launch in Q1');
  });
});
