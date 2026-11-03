/**
 * CLIENT QUOTATION PDF (pdfkit — pure JavaScript, no browser needed on the server).
 *
 * The same layout for every quotation, however it was created (Quinn or manual). Prints only
 * client-facing content: never internal notes, Quinn's notes, review flags or system wording.
 * Sections without content are left out and the numbering adjusts. Drafts carry a "DRAFT"
 * watermark (and cancelled quotations "CANCELLED") so an unfinished one is never mistaken for
 * the real thing.
 */
import PDFDocument from "pdfkit";
import path from "node:path";
import fs from "node:fs";
import { COMPANY } from "@/config/company";
import type { CompanyProfile } from "@/db/schema";
import type { QuoteBundle } from "./service";
import { computeTotals, formatRM, percentLabel, quantityText, splitMilestones } from "./calc";

const INK = "#1d2129";
const MUTED = "#69707d";
const RULE = "#e4e5ea";
const TINT = "#f4f1fd";
const M = 50; // page margin

/** The built-in PDF fonts only cover Western European characters; tidy up anything else. */
export function pdfSafe(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/[–−]/g, "–").replace(/—/g, "—").replace(/…/g, "...")
    .replace(/[→➡]/g, "->").replace(/≤/g, "<=").replace(/≥/g, ">=")
    .replace(/[•●▪‣⁃]/g, "•").replace(/ /g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ€‚ƒ„†‡ˆ‰Š‹ŒŽ™š›œžŸ–—•‘’“”]/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00+08:00").toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
}

export interface PdfOptions {
  company: CompanyProfile;
  preparedByName?: string | null;
}

export async function renderQuotationPdf(b: QuoteBundle, opts: PdfOptions): Promise<Buffer> {
  const { quotation: q, version: v, lines } = b;
  const c = opts.company;
  const watermark = q.status === "cancelled" ? "CANCELLED" : v.status === "finalised" ? null : "DRAFT";
  const doc = new PDFDocument({
    size: "A4", margins: { top: M, bottom: M + 10, left: M, right: M }, bufferPages: true,
    info: { Title: pdfSafe(`Quotation ${q.number}`), Author: pdfSafe(c.name), Subject: pdfSafe(q.projectTitle) },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (ch: Buffer) => chunks.push(ch));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const W = doc.page.width - M * 2;
  const brand = COMPANY.brandColor;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  let y = M;
  const ensure = (h: number) => { if (y + h > bottom()) { doc.addPage(); y = M; } };
  const T = (s: string) => pdfSafe(s);

  // ---------- Header: logo + company ----------
  const logo = path.join(process.cwd(), COMPANY.logoPath);
  if (fs.existsSync(logo)) doc.image(logo, M, M, { width: 140 });
  else doc.font("Helvetica-Bold").fontSize(20).fillColor(brand).text("NewGen", M, M);
  const right = { width: W / 2 + 20, align: "right" as const };
  const rx = M + W / 2 - 20;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(T(c.name), rx, M, right);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  if (c.registrationNo) doc.text(T(`Company No. ${c.registrationNo}`), rx, doc.y + 1, right);
  for (const l of (c.address ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) doc.text(T(l), rx, doc.y, right);
  const contact = [c.phone, c.email, c.website].filter(Boolean).join("  ·  ");
  if (contact) doc.text(T(contact), rx, doc.y + 1, right);
  y = Math.max(doc.y, M + 50) + 12;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(2).strokeColor(brand).stroke();
  y += 18;

  // ---------- Title + quotation details ----------
  doc.font("Helvetica-Bold").fontSize(24).fillColor(INK).text("QUOTATION", M, y);
  const meta: [string, string][] = [["Quotation No.", q.number], ["Date", fmtDate(v.quoteDate)], ["Valid until", fmtDate(v.validUntil)]];
  if (v.version > 1) meta.push(["Revision", String(v.version)]);
  let my = y + 2;
  const metaX = M + W - 220;
  for (const [k, val] of meta) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, metaX, my, { width: 90 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(T(val), metaX + 90, my, { width: 130, align: "right" });
    my += 15;
  }
  y = Math.max(my, y + 34) + 14;

  // ---------- Prepared for / project ----------
  const colW = W / 2 - 12;
  const label = (s: string, x: number, at: number) => doc.font("Helvetica-Bold").fontSize(7.5).fillColor(brand).text(s, x, at);
  label("PREPARED FOR", M, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(T(q.clientCompany), M, y + 12, { width: colW });
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  if (q.clientContactName) doc.text(T(`Attn: ${q.clientContactName}`), M, doc.y + 1, { width: colW });
  for (const s of [q.clientContactEmail, q.clientContactPhone]) if (s) doc.text(T(s), M, doc.y, { width: colW });
  if (q.clientAddress) doc.fillColor(MUTED).text(T(q.clientAddress), M, doc.y + 1, { width: colW });
  const leftEnd = doc.y;
  const px = M + W / 2 + 12;
  label("PROJECT", px, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(T(q.projectTitle), px, y + 12, { width: colW });
  if (opts.preparedByName) {
    const py = doc.y + 8;
    label("PREPARED BY", px, py);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(T(opts.preparedByName), px, py + 11, { width: colW });
  }
  y = Math.max(leftEnd, doc.y) + 22;

  // ---------- Section helpers ----------
  let sectionNo = 0;
  const heading = (title: string, minFollowing = 40) => {
    ensure(26 + minFollowing);
    sectionNo += 1;
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(INK).text(`${sectionNo}. ${title}`, M, y);
    y = doc.y + 3;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
    y += 8;
  };
  const subheading = (title: string) => {
    ensure(30);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(T(title), M, y);
    y = doc.y + 3;
  };
  const paragraph = (text: string, size = 9.5, color = INK, indent = 0) => {
    for (const para of T(text).split(/\n/)) {
      const p = para.trimEnd();
      doc.font("Helvetica").fontSize(size);
      const h = p ? doc.heightOfString(p, { width: W - indent, lineGap: 2 }) : size * 0.6;
      if (h < bottom() - M) ensure(h);
      if (p) doc.fillColor(color).text(p, M + indent, y, { width: W - indent, lineGap: 2 });
      y = (p ? doc.y : y + h) + 2;
    }
    y += 4;
  };
  const bullets = (items: string[]) => {
    doc.font("Helvetica").fontSize(9.5);
    for (const raw of items) {
      const it = T(raw);
      const h = doc.heightOfString(it, { width: W - 14, lineGap: 1.5 });
      ensure(h + 2);
      doc.fillColor(brand).text("•", M + 2, y);
      doc.fillColor(INK).text(it, M + 14, y, { width: W - 14, lineGap: 1.5 });
      y = doc.y + 2.5;
    }
    y += 6;
  };

  // ---------- 1. Overview & objectives ----------
  if (v.scopeSummary || v.objectives.length) {
    heading("Project Overview");
    if (v.scopeSummary) paragraph(v.scopeSummary);
    if (v.objectives.length) { subheading("Objectives"); bullets(v.objectives); }
  }

  // ---------- 2. Scope of work ----------
  const scope: [string, string[]][] = [
    ["Services included", v.services], ["Features and functionalities", v.features], ["Technical requirements", v.technicalRequirements],
  ];
  if (scope.some(([, xs]) => xs.length)) {
    heading("Scope of Work");
    for (const [t, xs] of scope) if (xs.length) { subheading(t); bullets(xs); }
  }
  if (v.deliverables.length) { heading("Deliverables"); bullets(v.deliverables); }
  if (v.exclusions.length) { heading("Exclusions"); paragraph("The following are not included in this quotation:", 9, MUTED); bullets(v.exclusions); }

  // ---------- Pricing ----------
  heading("Pricing", 70);
  const col = { no: M + 6, desc: M + 26, qty: M + W - 245, unit: M + W - 170, amt: M + W - 85 };
  const descW = col.qty - col.desc - 8;
  const tableHeader = () => {
    doc.rect(M, y, W, 22).fill(TINT);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK);
    doc.text("#", col.no, y + 7);
    doc.text("DESCRIPTION", col.desc, y + 7);
    doc.text("QTY", col.qty, y + 7, { width: 70, align: "right" });
    doc.text("UNIT PRICE", col.unit, y + 7, { width: 80, align: "right" });
    doc.text("AMOUNT (RM)", col.amt - 5, y + 7, { width: 90, align: "right" });
    y += 28;
  };
  tableHeader();
  lines.forEach((l, i) => {
    const desc = T(l.description);
    const details = l.details ? T(l.details) : null;
    doc.font("Helvetica-Bold").fontSize(9);
    const h1 = doc.heightOfString(desc, { width: descW });
    doc.font("Helvetica").fontSize(8);
    const h2 = details ? doc.heightOfString(details, { width: descW }) + 2 : 0;
    const rowH = Math.max(h1 + h2, 12) + 10;
    if (y + rowH > bottom()) { doc.addPage(); y = M; tableHeader(); }
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(String(i + 1), col.no, y);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(desc, col.desc, y, { width: descW });
    if (details) doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(details, col.desc, doc.y + 2, { width: descW });
    const unitPrice = l.unitPriceSen ?? (l.lineTotalSen !== null && l.quantity === 1 ? l.lineTotalSen : null);
    doc.font("Helvetica").fontSize(9).fillColor(INK)
      .text(T(quantityText(l.quantity, l.unitLabel)), col.qty, y, { width: 70, align: "right" })
      .text(unitPrice === null ? "—" : formatRM(unitPrice).replace("RM ", ""), col.unit, y, { width: 80, align: "right" })
      .text(l.lineTotalSen === null ? "—" : formatRM(l.lineTotalSen).replace("RM ", ""), col.amt - 5, y, { width: 90, align: "right" });
    y += rowH;
    doc.moveTo(M, y - 5).lineTo(M + W, y - 5).lineWidth(0.5).strokeColor(RULE).stroke();
  });

  const discount = v.discountType ? { type: v.discountType, value: v.discountValue ?? 0, label: v.discountLabel } : null;
  const tax = v.taxRateBp !== null && v.taxLabel ? { label: v.taxLabel, rateBp: v.taxRateBp } : null;
  const live = computeTotals(lines, discount, tax);
  const totals = v.totalSen !== null && v.subtotalSen !== null
    ? { subtotalSen: v.subtotalSen, discountSen: v.discountSen ?? 0, taxSen: v.taxSen ?? 0, totalSen: v.totalSen }
    : live;
  ensure(30 + (totals.discountSen ? 15 : 0) + (tax ? 15 : 0) + 30);
  const tx = M + W - 250;
  const totalRow = (k: string, val: string, strong = false) => {
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 11 : 9).fillColor(INK)
      .text(T(k), tx, y, { width: 150 }).text(val, tx + 150, y, { width: 100, align: "right" });
    y += strong ? 18 : 15;
  };
  y += 4;
  totalRow("Subtotal", formatRM(totals.subtotalSen));
  if (totals.discountSen) {
    const dl = discount?.label || "Discount";
    totalRow(discount?.type === "percent" ? `${dl} (${percentLabel(discount.value)})` : dl, `- ${formatRM(totals.discountSen)}`);
  }
  if (tax) totalRow(`${tax.label} (${percentLabel(tax.rateBp)})`, formatRM(totals.taxSen));
  doc.moveTo(tx, y).lineTo(M + W, y).lineWidth(1).strokeColor(brand).stroke();
  y += 7;
  totalRow("Total (MYR)", formatRM(totals.totalSen), true);
  y += 14;

  // ---------- Timeline ----------
  if (v.timelineDuration || v.timelineMilestones.length) {
    heading("Project Timeline");
    if (v.timelineDuration) paragraph(`Estimated duration: ${v.timelineDuration}`);
    if (v.timelineMilestones.length) {
      for (const m of v.timelineMilestones) {
        const lbl = T(m.label);
        doc.font("Helvetica").fontSize(9.5);
        const h = doc.heightOfString(lbl, { width: W - 160 });
        ensure(h + 6);
        doc.fillColor(INK).text(lbl, M + 6, y, { width: W - 160 });
        doc.fillColor(MUTED).text(T(m.timing || ""), M + W - 150, y, { width: 150, align: "right" });
        y += h + 4;
        doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor(RULE).stroke();
        y += 5;
      }
      y += 4;
    }
  }

  // ---------- Payment terms ----------
  const bankReady = c.bankName && c.bankAccountName && c.bankAccountNo;
  if (v.paymentMilestones.length || v.paymentNotes || bankReady) {
    heading("Payment Terms");
    if (v.paymentMilestones.length) {
      for (const m of splitMilestones(totals.totalSen, v.paymentMilestones)) {
        ensure(18);
        doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(T(m.label), M + 6, y, { width: W - 230 });
        doc.fillColor(MUTED).text(percentLabel(m.percentBp), M + W - 220, y, { width: 60, align: "right" });
        doc.font("Helvetica-Bold").fillColor(INK).text(formatRM(m.amountSen), M + W - 150, y, { width: 150, align: "right" });
        y = doc.y + 4;
        doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor(RULE).stroke();
        y += 5;
      }
      y += 4;
    }
    if (v.paymentNotes) paragraph(v.paymentNotes);
    if (bankReady) {
      subheading("Payment details");
      paragraph(`Bank: ${c.bankName}\nAccount name: ${c.bankAccountName}\nAccount number: ${c.bankAccountNo}`);
    }
  }

  // ---------- Terms & conditions ----------
  if (v.validUntil || v.termsText || v.projectTerms || v.assumptions.length) {
    heading("Terms & Conditions");
    if (v.validUntil) paragraph(`This quotation is valid until ${fmtDate(v.validUntil)}.`);
    if (v.termsText) paragraph(v.termsText, 9);
    if (v.projectTerms) { subheading("Project-specific terms"); paragraph(v.projectTerms, 9); }
    if (v.assumptions.length) { subheading("Assumptions"); bullets(v.assumptions); }
  }

  // ---------- Acceptance ----------
  heading("Acceptance", 110);
  paragraph("To accept this quotation, please sign and return a copy.", 9, MUTED);
  y += 6;
  const sigW = W / 2 - 16;
  const sigLine = (x: number, at: number, caption: string) => {
    doc.moveTo(x, at).lineTo(x + sigW, at).lineWidth(0.6).strokeColor(MUTED).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(caption, x, at + 3, { width: sigW });
  };
  ensure(90);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(T(`For ${q.clientCompany}`), M, y, { width: sigW });
  doc.text(T(`For ${c.name}`), M + W / 2 + 16, y, { width: sigW });
  const sy = y + 42;
  sigLine(M, sy, "Authorised signature & company stamp");
  sigLine(M + W / 2 + 16, sy, opts.preparedByName ? T(`${opts.preparedByName}`) : "Authorised signature");
  sigLine(M, sy + 34, "Name & date");
  y = sy + 50;

  // ---------- Every page: watermark (drafts) + footer ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would make pdfkit start a new page; lift it while decorating.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (watermark) {
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font("Helvetica-Bold").fontSize(100);
      const size = Math.min(110, Math.floor((100 * doc.page.width * 0.78) / doc.widthOfString(watermark)));
      doc.fontSize(size).fillColor("#9aa0ab").opacity(0.12)
        .text(watermark, 0, doc.page.height / 2 - size / 2, { width: doc.page.width, align: "center", lineBreak: false });
      doc.restore();
      doc.opacity(1);
    }
    const fy = doc.page.height - 38;
    doc.moveTo(M, fy - 8).lineTo(M + W, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
      .text(T(`${c.name}  ·  Quotation ${q.number}${v.version > 1 ? ` (revision ${v.version})` : ""}`), M, fy, { width: W * 0.7, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M + W * 0.7, fy, { width: W * 0.3, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
