import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { writeFileSync } from "node:fs";
import { createDb, type DB } from "@/db/client";
import { users, quotationLines, quotationVersions, auditLog } from "@/db/schema";
import type { Actor } from "@/auth/permissions";
import { createCatalogueDraft, approveCatalogueItem, createPolicyDraft, approvePolicy } from "@/catalogue/service";
import {
  createQuotation, addCatalogueLine, addCustomLine, removeLine, updateScope, submitForApproval, recallSubmission,
  approveQuotation, rejectQuotation, reviseQuotation, cancelQuotation, loadQuote, computeTotals, splitMilestones,
  updateTerms, loadTerms, previousTermsFor, resolveTermsStatus, describeTerms,
} from "@/quotations/service";
import { createTemplate, updateTemplate, listTemplates } from "@/terms/service";
import { renderQuotationPdf } from "@/quotations/pdf";

const url = process.env.TEST_DATABASE_URL!;
let db: DB; let pool: import("pg").Pool;
const A = {} as Record<"sales" | "sales2" | "tech" | "fin1" | "fin2" | "admin", Actor>;

beforeAll(async () => { ({ db, pool } = createDb(url)); await migrate(db, { migrationsFolder: "./drizzle" }); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await db.execute(sql`TRUNCATE audit_log, quotation_lines, quotation_versions, quotations, terms_templates, catalogue_items, commercial_policies, users RESTART IDENTITY CASCADE`);
  const rows = await db.insert(users).values([
    { email: "s@t.local", name: "Sally Sales", role: "sales" }, { email: "s2@t.local", name: "Sam Sales", role: "sales" },
    { email: "t@t.local", name: "Tech", role: "technical" }, { email: "f1@t.local", name: "Fin One", role: "finance" },
    { email: "f2@t.local", name: "Fin Two", role: "finance" }, { email: "a@t.local", name: "Admin", role: "admin" },
  ]).returning();
  (["sales", "sales2", "tech", "fin1", "fin2", "admin"] as const).forEach((k, i) => { A[k] = { id: rows[i].id, role: rows[i].role, email: rows[i].email }; });
});

async function setupPrices(tax = false) {
  const web = await createCatalogueDraft(db, A.fin1, {
    code: "WEB-TEST", name: "Corporate Website (TEST)", category: "website", kind: "package", pricingModel: "base_plus_units",
    priceSen: 500_000, includedUnits: 5, extraUnitPriceSen: 50_000, unitLabel: "page", maxQuantity: 10, validFrom: "2026-01-01",
  });
  await approveCatalogueItem(db, A.fin2, web.id);
  const host = await createCatalogueDraft(db, A.fin1, {
    code: "HOST-TEST", name: "Hosting (TEST)", category: "hosting", kind: "add_on", pricingModel: "per_unit",
    priceSen: 150_000, unitLabel: "year", validFrom: "2026-01-01",
  });
  await approveCatalogueItem(db, A.fin2, host.id);
  const p = await createPolicyDraft(db, A.fin1, {
    paymentMilestones: [{ label: "Deposit", percentBp: 5000 }, { label: "Before launch", percentBp: 3000 }, { label: "On completion", percentBp: 2000 }],
    quoteValidityDays: 30, validFrom: "2026-01-01",
    ...(tax ? { taxEnabled: true, taxLabel: "SST", taxRateBp: 800 } : {}),
  });
  await approvePolicy(db, A.fin2, p.id);
}

async function readyQuote(actor = A.sales) {
  const q = await createQuotation(db, actor, { clientCompany: "Demo Trading Sdn Bhd (TEST)", clientContactName: "Mr Lim", clientContactPhone: "012-000 0000", projectTitle: "Corporate website revamp" });
  await addCatalogueLine(db, actor, q.id, { catalogueCode: "WEB-TEST", quantity: 7, details: "Home, About, Services x3, Contact, Careers" });
  await addCustomLine(db, actor, q.id, { description: "Stock enquiry form linked to Google Sheets", quantity: 1, unitPriceSen: 250_000 });
  await updateScope(db, actor, q.id, { scopeSummary: "Design and build a 7-page corporate website with an enquiry form.", deliverables: ["Responsive website", "Admin training session"], exclusions: ["Copywriting", "Photography"] });
  await updateTerms(db, actor, q.id, TEST_TERMS);
  return q;
}

/** Fictional test wording only. */
const TEST_TERMS = "1. TEST CLAUSE: deposit is payable before work starts.\n2. TEST CLAUSE: two revision rounds are included.";

describe("Creating a quotation", () => {
  it("gets a sequential number and starts as draft v1", async () => {
    const q1 = await createQuotation(db, A.sales, { clientCompany: "Client One", projectTitle: "Website" });
    const q2 = await createQuotation(db, A.sales, { clientCompany: "Client Two", projectTitle: "Mobile app" });
    expect(q1.number).toMatch(/^NGQ-\d{4}-\d{4,}$/);
    const n = (x: string) => Number(x.split("-")[2]);
    expect(n(q2.number)).toBe(n(q1.number) + 1); // consecutive, never reused
    expect(q1.status).toBe("draft");
  });

  it("technical users can't create quotations", async () => {
    await expect(createQuotation(db, A.tech, { clientCompany: "X Co", projectTitle: "Thing" })).rejects.toThrow(/not allowed/);
  });

  it("Sales only see their own quotations; Finance sees all", async () => {
    const q = await createQuotation(db, A.sales, { clientCompany: "Private Co", projectTitle: "Secret project" });
    expect(await loadQuote(db, A.sales2, q.id)).toBeNull();
    expect(await loadQuote(db, A.fin1, q.id)).not.toBeNull();
    await expect(addCustomLine(db, A.sales2, q.id, { description: "Sneaky line", quantity: 1, unitPriceSen: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Lines", () => {
  it("price-list lines are priced by the engine; custom lines use the proposed amount", async () => {
    await setupPrices();
    const q = await readyQuote();
    const b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.lines.map((l) => l.lineTotalSen)).toEqual([600_000, 250_000]); // 5,000 + 2×500 ; custom 2,500
    expect(b.lines[0].unitPriceSen).toBeNull(); // base+units has no single unit price
  });

  it("refuses unapproved items, duplicates and over-limit quantities", async () => {
    await setupPrices();
    const q = await createQuotation(db, A.sales, { clientCompany: "C Co", projectTitle: "Project one" });
    await expect(addCatalogueLine(db, A.sales, q.id, { catalogueCode: "NOPE", quantity: 1 })).rejects.toMatchObject({ code: "NOT_APPROVED" });
    await addCatalogueLine(db, A.sales, q.id, { catalogueCode: "WEB-TEST", quantity: 5 });
    await expect(addCatalogueLine(db, A.sales, q.id, { catalogueCode: "WEB-TEST", quantity: 2 })).rejects.toMatchObject({ code: "DUPLICATE" });
    const q2 = await createQuotation(db, A.sales, { clientCompany: "C Co", projectTitle: "Project two" });
    await expect(addCatalogueLine(db, A.sales, q2.id, { catalogueCode: "WEB-TEST", quantity: 20 })).rejects.toMatchObject({ code: "CANT_PRICE" });
  });

  it("an add-on can sit alongside custom lines", async () => {
    await setupPrices();
    const q = await createQuotation(db, A.sales, { clientCompany: "C Co", projectTitle: "Custom system" });
    await addCustomLine(db, A.sales, q.id, { description: "Custom inventory system", quantity: 1, unitPriceSen: 3_000_000 });
    await addCatalogueLine(db, A.sales, q.id, { catalogueCode: "HOST-TEST", quantity: 2 });
    await updateScope(db, A.sales, q.id, { scopeSummary: "Custom system plus hosting." });
    await updateTerms(db, A.sales, q.id, TEST_TERMS);
    const v = await submitForApproval(db, A.sales, q.id);
    expect(v.totalSen).toBe(3_000_000 + 300_000);
  });

  it("lines can be removed while draft", async () => {
    await setupPrices();
    const q = await readyQuote();
    const b = (await loadQuote(db, A.sales, q.id))!;
    await removeLine(db, A.sales, q.id, b.lines[1].id);
    expect((await loadQuote(db, A.sales, q.id))!.lines).toHaveLength(1);
  });
});

describe("Approval workflow", () => {
  it("full path: submit → Finance approves → frozen, valid until set", async () => {
    await setupPrices();
    const q = await readyQuote();
    const v = await submitForApproval(db, A.sales, q.id);
    expect(v.status).toBe("submitted");
    expect(v.totalSen).toBe(850_000);
    expect(v.policySnapshot?.paymentMilestones).toHaveLength(3);
    await expect(addCustomLine(db, A.sales, q.id, { description: "Late addition", quantity: 1, unitPriceSen: 1 })).rejects.toMatchObject({ code: "NOT_DRAFT" });

    await expect(approveQuotation(db, A.sales, q.id)).rejects.toThrow(/not allowed/);
    await expect(approveQuotation(db, A.tech, q.id)).rejects.toThrow(/not allowed/);
    const ok = await approveQuotation(db, A.fin1, q.id, "Custom form price checked");
    expect(ok.status).toBe("approved");
    expect(ok.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("can't submit without lines, scope, terms & conditions or approved payment terms", async () => {
    const q = await createQuotation(db, A.sales, { clientCompany: "C Co", projectTitle: "Project one" });
    await expect(submitForApproval(db, A.sales, q.id)).rejects.toMatchObject({ code: "NO_LINES" });
    await addCustomLine(db, A.sales, q.id, { description: "Something custom", quantity: 1, unitPriceSen: 100_000 });
    await expect(submitForApproval(db, A.sales, q.id)).rejects.toMatchObject({ code: "NO_SCOPE" });
    await updateScope(db, A.sales, q.id, { scopeSummary: "Something." });
    await expect(submitForApproval(db, A.sales, q.id)).rejects.toMatchObject({ code: "NO_TERMS" });
    await updateTerms(db, A.sales, q.id, TEST_TERMS);
    await expect(submitForApproval(db, A.sales, q.id)).rejects.toMatchObject({ code: "NO_POLICY" });
  });

  it("Finance can't approve a quotation they prepared themselves", async () => {
    await setupPrices();
    const q = await readyQuote(A.fin1);
    await submitForApproval(db, A.fin1, q.id);
    await expect(approveQuotation(db, A.fin1, q.id)).rejects.toMatchObject({ code: "SELF_APPROVAL" });
    expect((await approveQuotation(db, A.fin2, q.id)).status).toBe("approved");
  });

  it("reject needs a reason; Sales then revises into v2 with lines copied", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await expect(rejectQuotation(db, A.fin1, q.id, "")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await rejectQuotation(db, A.fin1, q.id, "Enquiry form price too low, use RM 3,000");
    const v2 = await reviseQuotation(db, A.sales, q.id);
    expect(v2.version).toBe(2);
    const b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.version.status).toBe("draft");
    expect(b.lines).toHaveLength(2);
    expect(b.versions.map((v) => v.status)).toEqual(["rejected", "draft"]);
    // v1 stays frozen
    const v1lines = await db.select().from(quotationLines).where(eq(quotationLines.versionId, b.versions[0].id));
    expect(v1lines).toHaveLength(2);
  });

  it("recall pulls a submission back to draft", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await recallSubmission(db, A.sales, q.id);
    const b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.version.status).toBe("draft");
    expect(b.version.totalSen).toBeNull();
  });

  it("revising an approved quotation keeps the approved version intact", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await approveQuotation(db, A.fin1, q.id);
    await reviseQuotation(db, A.sales, q.id);
    const b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.versions.map((v) => v.status)).toEqual(["approved", "draft"]);
    expect(b.quotation.status).toBe("draft");
  });

  it("cancel needs a reason and stops further changes", async () => {
    await setupPrices();
    const q = await readyQuote();
    await expect(cancelQuotation(db, A.sales, q.id, "")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await cancelQuotation(db, A.sales, q.id, "Client chose another vendor");
    await expect(addCustomLine(db, A.sales, q.id, { description: "More", quantity: 1, unitPriceSen: 1 })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("every step is in the audit log", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await rejectQuotation(db, A.fin1, q.id, "Please add hosting");
    await reviseQuotation(db, A.sales, q.id);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, q.id))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["quote.created", "quote.line_added", "quote.scope_updated", "quote.submitted", "quote.rejected", "quote.revised"]));
  });
});

describe("Database safety nets", () => {
  it("approved versions and their lines can't be changed even with direct SQL", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await approveQuotation(db, A.fin1, q.id);
    const b = (await loadQuote(db, A.sales, q.id))!;
    const err = (p: Promise<unknown>) => expect(p).rejects.toSatisfy((e: unknown) => String((e as { cause?: Error }).cause?.message ?? e).includes("FROZEN_QUOTATION"));
    await err(db.update(quotationVersions).set({ totalSen: 1 }).where(eq(quotationVersions.id, b.version.id)));
    await err(db.update(quotationLines).set({ lineTotalSen: 1 }).where(eq(quotationLines.versionId, b.version.id)));
    await err(db.delete(quotationLines).where(eq(quotationLines.versionId, b.version.id)));
  });
});

describe("Terms & conditions", () => {
  const STANDARD = "1. TEST standard clause one.\n2. TEST standard clause two.";
  const GLC = "1. TEST GLC clause: payment within 60 days of invoice.";

  it("only Finance/Admin manage templates; names are unique; one default at a time", async () => {
    await expect(createTemplate(db, A.sales, { name: "Sneaky", body: STANDARD })).rejects.toThrow(/not allowed/);
    const t1 = await createTemplate(db, A.fin1, { name: "Standard (TEST)", body: STANDARD, isDefault: true });
    await expect(createTemplate(db, A.fin2, { name: "standard (test)", body: GLC })).rejects.toMatchObject({ code: "NAME_TAKEN" });
    const t2 = await createTemplate(db, A.fin2, { name: "GLC (TEST)", body: GLC, isDefault: true });
    const all = await listTemplates(db);
    expect(all.filter((t) => t.isDefault).map((t) => t.id)).toEqual([t2.id]);
    // Retiring the default leaves no default.
    await updateTemplate(db, A.fin1, t2.id, { name: t2.name, body: t2.body, isDefault: true, active: false });
    expect((await listTemplates(db)).some((t) => t.isDefault)).toBe(false);
    expect((await listTemplates(db, { activeOnly: true })).map((t) => t.id)).toEqual([t1.id]);
  });

  it("new quotations start with the default template; Sales can adjust them per client", async () => {
    const t = await createTemplate(db, A.fin1, { name: "Standard (TEST)", body: STANDARD, isDefault: true });
    const q = await createQuotation(db, A.sales, { clientCompany: "Client A", projectTitle: "Website" });
    let b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.version.termsText).toBe(STANDARD);
    expect(describeTerms((await resolveTermsStatus(db, [b.version])).get(b.version.id))).toMatchObject({ short: "Standard", review: false });

    await updateTerms(db, A.sales, q.id, STANDARD + "\n3. TEST client-specific clause.");
    b = (await loadQuote(db, A.sales, q.id))!;
    const s = describeTerms((await resolveTermsStatus(db, [b.version])).get(b.version.id));
    expect(s).toMatchObject({ short: "Edited", review: true });
    expect(s.label).toContain(t.name);

    // Changing the template later doesn't touch the quotation's own copy.
    await updateTemplate(db, A.fin2, t.id, { name: t.name, body: "TEST completely new wording.", isDefault: true });
    expect((await loadQuote(db, A.sales, q.id))!.version.termsText).toContain("client-specific");
  });

  it("loading a template or this client's earlier approved terms replaces the text", async () => {
    await setupPrices();
    const glc = await createTemplate(db, A.fin1, { name: "GLC (TEST)", body: GLC });
    const q1 = await readyQuote();
    await loadTerms(db, A.sales, q1.id, { kind: "template", templateId: glc.id });
    expect((await loadQuote(db, A.sales, q1.id))!.version.termsText).toBe(GLC);
    await submitForApproval(db, A.sales, q1.id);
    await approveQuotation(db, A.fin1, q1.id);

    // A new quotation for the same client (spelt slightly differently) offers q1's approved terms.
    const q2 = await createQuotation(db, A.sales, { clientCompany: "DEMO TRADING SDN. BHD. (test)", projectTitle: "Phase 2" });
    const prev = await previousTermsFor(db, A.sales, q2);
    expect(prev).toHaveLength(1);
    await loadTerms(db, A.sales, q2.id, { kind: "previous", versionId: prev[0].versionId });
    const v2 = (await loadQuote(db, A.sales, q2.id))!.version;
    expect(v2.termsText).toBe(GLC);
    expect(describeTerms((await resolveTermsStatus(db, [v2])).get(v2.id))).toMatchObject({ short: "Same as before", review: false });

    // Another salesperson can't see or load them.
    const q3 = await createQuotation(db, A.sales2, { clientCompany: "Demo Trading Sdn Bhd (TEST)", projectTitle: "Other" });
    expect(await previousTermsFor(db, A.sales2, q3)).toHaveLength(0);
    await expect(loadTerms(db, A.sales2, q3.id, { kind: "previous", versionId: prev[0].versionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an inactive template can't be loaded", async () => {
    const t = await createTemplate(db, A.fin1, { name: "Old (TEST)", body: GLC });
    await updateTemplate(db, A.fin1, t.id, { name: t.name, body: t.body, active: false });
    const q = await createQuotation(db, A.sales, { clientCompany: "Client B", projectTitle: "Site" });
    await expect(loadTerms(db, A.sales, q.id, { kind: "template", templateId: t.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("terms are locked after submission (app and database) and carried into revisions", async () => {
    await setupPrices();
    const q = await readyQuote();
    await submitForApproval(db, A.sales, q.id);
    await expect(updateTerms(db, A.sales, q.id, "TEST changed")).rejects.toMatchObject({ code: "NOT_DRAFT" });
    const b = (await loadQuote(db, A.sales, q.id))!;
    await expect(db.update(quotationVersions).set({ termsText: "tampered" }).where(eq(quotationVersions.id, b.version.id)))
      .rejects.toSatisfy((e: unknown) => String((e as { cause?: Error }).cause?.message ?? e).includes("FROZEN_QUOTATION"));
    await rejectQuotation(db, A.fin1, q.id, "Please change clause 2");
    await reviseQuotation(db, A.sales, q.id);
    expect((await loadQuote(db, A.sales, q.id))!.version.termsText).toBe(TEST_TERMS);
  });

  it("long terms flow onto extra pages in the PDF", async () => {
    await setupPrices();
    const q = await readyQuote();
    const long = Array.from({ length: 70 }, (_, i) => `${i + 1}. TEST clause ${i + 1}: this is a deliberately long line of wording to check that the PDF wraps and paginates terms properly.`).join("\n");
    await updateTerms(db, A.sales, q.id, long);
    const pdf = await renderQuotationPdf((await loadQuote(db, A.sales, q.id))!);
    const pages = Number(pdf.toString("latin1").match(/\/Type \/Pages[\s\S]*?\/Count (\d+)/)?.[1]);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThanOrEqual(4);
    if (process.env.PDF_OUT) writeFileSync(`${process.env.PDF_OUT}/long-terms.pdf`, pdf);
  });

  it("terms are audited", async () => {
    const q = await createQuotation(db, A.sales, { clientCompany: "Client C", projectTitle: "App" });
    await updateTerms(db, A.sales, q.id, TEST_TERMS);
    const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, q.id))).map((r) => r.action);
    expect(actions).toContain("quote.terms_updated");
  });
});

describe("Totals and PDF", () => {
  it("tax is applied only when the policy has it, and milestones always add up", async () => {
    expect(computeTotals([{ lineTotalSen: 100_001 }], null)).toEqual({ subtotalSen: 100_001, tax: null, totalSen: 100_001 });
    const t = computeTotals([{ lineTotalSen: 100_001 }], { label: "SST", rateBp: 800 });
    expect(t.tax?.amountSen).toBe(8_000);
    const parts = splitMilestones(100_001, [{ label: "A", percentBp: 3333 }, { label: "B", percentBp: 3333 }, { label: "C", percentBp: 3334 }]);
    expect(parts.reduce((s, p) => s + p.amountSen, 0)).toBe(100_001);
  });

  it("renders an approved PDF and a watermarked draft preview", async () => {
    await setupPrices(true);
    const q = await readyQuote();
    const draft = await renderQuotationPdf((await loadQuote(db, A.sales, q.id))!);
    expect(draft.subarray(0, 5).toString()).toBe("%PDF-");
    await submitForApproval(db, A.sales, q.id);
    await approveQuotation(db, A.fin1, q.id);
    const b = (await loadQuote(db, A.sales, q.id))!;
    expect(b.version.taxSen).toBe(68_000); // 8% of 850,000 sen
    const pdf = await renderQuotationPdf(b, { approverName: "Fin One", preparedByName: "Sally Sales" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    if (process.env.PDF_OUT) { writeFileSync(`${process.env.PDF_OUT}/approved.pdf`, pdf); writeFileSync(`${process.env.PDF_OUT}/draft.pdf`, draft); }
  });
});
