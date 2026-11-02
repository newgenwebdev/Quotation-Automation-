/**
 * BRANDED QUOTATION PDF (pdfkit — pure JavaScript, no browser needed on the server).
 *
 * Prints ONLY what was approved: lines, totals and terms frozen at submission, the Finance
 * decision, and validity from the approved policy. A timeline is printed only if Sales
 * filled in a confirmed one. Anything not yet approved is stamped "DRAFT – NOT FOR CLIENT".
 */
import PDFDocument from "pdfkit";
import path from "node:path";
import fs from "node:fs";
import { COMPANY } from "@/config/company";
import { formatSen } from "@/pricing/engine";
import type { QuoteBundle } from "./service";
import { computeTotals, splitMilestones } from "./service";

const INK = "#1b1d22";
const MUTED = "#6b6f78";
const LINE = "#e3e3df";
const M = 50; // page margin

function fmtDate(iso: string | Date | null): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso + "T00:00:00+08:00") : iso;
  return d.toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
}

export interface PdfOptions {
  approverName?: string | null;
  preparedByName?: string | null;
}

export function isClientReady(b: QuoteBundle): boolean {
  return b.version.status === "approved";
}

export async function renderQuotationPdf(b: QuoteBundle, opts: PdfOptions = {}): Promise<Buffer> {
  const { quotation: q, version: v, lines } = b;
  const draft = !isClientReady(b);
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: {
    Title: `Quotation ${q.number} v${v.version}`, Author: COMPANY.name, Subject: q.projectTitle,
  } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const W = doc.page.width - M * 2;
  const brand = COMPANY.brandColor;

  // ---------- Header ----------
  const logo = path.join(process.cwd(), COMPANY.logoPath);
  if (fs.existsSync(logo)) doc.image(logo, M, M, { width: 150 });
  else doc.font("Helvetica-Bold").fontSize(20).fillColor(brand).text("NewGen", M, M);

  doc.font("Helvetica-Bold").fontSize(9).fillColor(INK)
    .text(COMPANY.name, M + W / 2, M, { width: W / 2, align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(`Company No. ${COMPANY.registration}`, { width: W / 2, align: "right" });
  for (const l of COMPANY.addressLines) doc.text(l, { width: W / 2, align: "right" });

  doc.moveTo(M, M + 62).lineTo(M + W, M + 62).lineWidth(2).strokeColor(brand).stroke();

  // ---------- Title + meta ----------
  let y = M + 80;
  doc.font("Helvetica-Bold").fontSize(22).fillColor(INK).text("QUOTATION", M, y);
  const metaX = M + W - 210;
  const meta: [string, string][] = [
    ["Quotation no.", q.number],
    ["Version", String(v.version)],
    ["Date", fmtDate(v.decidedAt ?? v.submittedAt ?? v.createdAt)],
    ["Valid until", draft ? "Upon approval" : fmtDate(v.validUntil)],
  ];
  let my = y;
  for (const [k, val] of meta) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, metaX, my, { width: 80 });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(val, metaX + 80, my, { width: 130, align: "right" });
    my += 15;
  }

  // ---------- Bill to / project ----------
  y = Math.max(my, y + 30) + 14;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(brand).text("PREPARED FOR", M, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(q.clientCompany, M, y + 12, { width: W / 2 - 10 });
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  for (const s of [q.clientContactName, q.clientContactPhone, q.clientContactEmail]) if (s) doc.text(s, { width: W / 2 - 10 });
  const leftEnd = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(brand).text("PROJECT", M + W / 2, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(q.projectTitle, M + W / 2, y + 12, { width: W / 2 });
  y = Math.max(leftEnd, doc.y) + 16;

  // ---------- Scope summary ----------
  if (v.scopeSummary) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text("Scope of work", M, y);
    doc.font("Helvetica").fontSize(9).fillColor(INK).text(v.scopeSummary, M, doc.y + 4, { width: W, lineGap: 2 });
    y = doc.y + 14;
  }

  // ---------- Line items ----------
  const col = { no: M, desc: M + 24, qty: M + W - 210, unit: M + W - 160, amt: M + W - 80 };
  const tableHeader = (at: number) => {
    doc.rect(M, at, W, 20).fill("#f3f0fc");
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK);
    doc.text("#", col.no + 4, at + 6);
    doc.text("DESCRIPTION", col.desc, at + 6);
    doc.text("QTY", col.qty, at + 6, { width: 40, align: "right" });
    doc.text("UNIT PRICE", col.unit, at + 6, { width: 72, align: "right" });
    doc.text("AMOUNT", col.amt, at + 6, { width: 80, align: "right" });
    return at + 26;
  };
  const bottom = () => doc.page.height - M - 40;
  y = tableHeader(y);
  lines.forEach((l, i) => {
    const descW = col.qty - col.desc - 10;
    doc.font("Helvetica-Bold").fontSize(9);
    const h1 = doc.heightOfString(l.description, { width: descW });
    doc.font("Helvetica").fontSize(8);
    const h2 = l.details ? doc.heightOfString(l.details, { width: descW }) + 2 : 0;
    const rowH = Math.max(h1 + h2, 12) + 10;
    if (y + rowH > bottom()) { doc.addPage(); y = tableHeader(M); }
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(String(i + 1), col.no + 4, y);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK).text(l.description, col.desc, y, { width: descW });
    if (l.details) doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(l.details, col.desc, doc.y + 2, { width: descW });
    const unit = l.unitLabel ? ` ${l.unitLabel}${l.quantity > 1 ? "s" : ""}` : "";
    doc.font("Helvetica").fontSize(9).fillColor(INK)
      .text(`${l.quantity}${unit}`, col.qty - 30, y, { width: 70, align: "right" })
      .text(l.unitPriceSen !== null ? formatSen(l.unitPriceSen) : "—", col.unit, y, { width: 72, align: "right" })
      .text(formatSen(l.lineTotalSen ?? 0), col.amt, y, { width: 80, align: "right" });
    y += rowH;
    doc.moveTo(M, y - 5).lineTo(M + W, y - 5).lineWidth(0.5).strokeColor(LINE).stroke();
  });

  // ---------- Totals ----------
  // Approved/submitted versions use the frozen totals; drafts show a live preview.
  const tax = v.policySnapshot?.tax ?? null;
  const live = computeTotals(lines, tax);
  const subtotal = v.subtotalSen ?? live.subtotalSen;
  const taxAmt = v.taxSen ?? live.tax?.amountSen ?? 0;
  const total = v.totalSen ?? live.totalSen;
  if (y + 70 > bottom()) { doc.addPage(); y = M; }
  const tx = M + W - 220;
  const totalRow = (label: string, val: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK)
      .text(label, tx, y, { width: 120 }).text(val, tx + 120, y, { width: 100, align: "right" });
    y += bold ? 18 : 14;
  };
  y += 4;
  totalRow("Subtotal", formatSen(subtotal));
  if (tax) totalRow(`${tax.label} (${tax.rateBp / 100}%)`, formatSen(taxAmt));
  doc.moveTo(tx, y).lineTo(M + W, y).lineWidth(1).strokeColor(brand).stroke();
  y += 6;
  totalRow("Total (MYR)", formatSen(total), true);
  y += 10;

  // ---------- Sections ----------
  const section = (title: string, body: () => void) => {
    if (y + 50 > bottom()) { doc.addPage(); y = M; }
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(title, M, y);
    doc.moveDown(0.3);
    body();
    y = doc.y + 12;
  };
  const bullets = (items: string[]) => {
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    for (const it of items) doc.text(`•  ${it}`, M + 6, doc.y, { width: W - 6, lineGap: 1 });
  };

  if (v.deliverables.length) section("Deliverables", () => bullets(v.deliverables));
  if (v.exclusions.length) section("Not included", () => bullets(v.exclusions));
  if (v.confirmedTimeline) section("Timeline", () => doc.font("Helvetica").fontSize(9).fillColor(INK).text(v.confirmedTimeline!, M, doc.y, { width: W }));

  const snap = v.policySnapshot;
  if (snap?.paymentMilestones.length) {
    section("Payment schedule", () => {
      for (const m of splitMilestones(total, snap.paymentMilestones)) {
        const rowY = doc.y;
        doc.font("Helvetica").fontSize(9).fillColor(INK).text(`${m.label} (${m.percentBp / 100}%)`, M + 6, rowY, { width: 260 });
        doc.text(formatSen(m.amountSen), M + 270, rowY, { width: 100, align: "right" });
      }
    });
  }
  if (COMPANY.bank) {
    const bank = COMPANY.bank;
    section("Payment details", () => doc.font("Helvetica").fontSize(9).fillColor(INK)
      .text(`${bank.bank} · ${bank.accountName} · ${bank.accountNumber}`, M + 6, doc.y, { width: W }));
  }
  section("Terms", () => {
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    if (snap) doc.text(`This quotation is valid for ${snap.quoteValidityDays} days from the date of approval${draft ? "" : ` (until ${fmtDate(v.validUntil)})`}.`, M + 6, doc.y, { width: W - 6 });
    doc.text("Work outside the scope above will be quoted separately.", M + 6, doc.y, { width: W - 6 });
    if (snap?.termsText) doc.text(snap.termsText, M + 6, doc.y + 2, { width: W - 6 });
  });

  // ---------- Approval ----------
  if (y + 40 > bottom()) { doc.addPage(); y = M; }
  doc.font("Helvetica").fontSize(8).fillColor(MUTED);
  if (!draft) {
    doc.text(`Approved by ${COMPANY.name} Finance${opts.approverName ? ` (${opts.approverName})` : ""} on ${fmtDate(v.decidedAt)}.`, M, y, { width: W });
  }
  if (opts.preparedByName) doc.text(`Prepared by ${opts.preparedByName}.`, M, doc.y, { width: W });
  doc.text("This is a computer-generated quotation.", M, doc.y, { width: W });

  // ---------- Every page: watermark (drafts) + footer ----------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would make pdfkit start a new page; lift the margin while decorating.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (draft) {
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font("Helvetica-Bold").fontSize(54).fillColor("#d64545").opacity(0.13)
        .text("DRAFT – NOT FOR CLIENT", 0, doc.page.height / 2 - 30, { width: doc.page.width, align: "center", lineBreak: false });
      doc.restore();
      doc.opacity(1);
    }
    const fy = doc.page.height - M + 10;
    doc.font("Helvetica").fontSize(7).fillColor(MUTED)
      .text(`${COMPANY.name} · ${q.number} v${v.version}`, M, fy, { width: W / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M + W / 2, fy, { width: W / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
