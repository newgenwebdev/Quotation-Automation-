import {
  addCatalogueLine, addCustomLine, approveQuotation, cancelQuotation, loadTerms, recallSubmission, rejectQuotation,
  removeLine, reviseQuotation, submitForApproval, updateHeader, updateScope, updateTerms,
} from "@/quotations/service";
import { back, db, formHandler, lines, optStr, ringgitToSen, str } from "@/web/server";
import type { Permission } from "@/auth/permissions";

type Ctx = { params: Promise<{ id: string; action: string }> };

function wholeNumber(v: string, field: string): number {
  if (!/^\d+$/.test(v.trim())) throw Object.assign(new Error(`${field} must be a whole number.`), { code: "BAD_INPUT" });
  return Number(v);
}

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const page = `/quotations/${id}`;
  const run = (permission: Permission | undefined, fn: Parameters<typeof formHandler>[1]) => formHandler({ permission, errorPath: page }, fn)(req);

  switch (action) {
    case "header":
      return run(undefined, async ({ user, form }) => {
        await updateHeader(db(), user, id, {
          clientCompany: str(form, "clientCompany"), projectTitle: str(form, "projectTitle"),
          clientContactName: str(form, "clientContactName"), clientContactPhone: str(form, "clientContactPhone"),
          clientContactEmail: str(form, "clientContactEmail"),
        });
        return back(page, { ok: "Client details saved." });
      });
    case "scope":
      return run(undefined, async ({ user, form }) => {
        await updateScope(db(), user, id, {
          scopeSummary: str(form, "scopeSummary"), deliverables: lines(form, "deliverables"), exclusions: lines(form, "exclusions"),
          confirmedTimeline: str(form, "confirmedTimeline"), internalNotes: str(form, "internalNotes"),
        });
        return back(page, { ok: "Scope saved." });
      });
    case "terms":
      return run(undefined, async ({ user, form }) => {
        await updateTerms(db(), user, id, String(form.get("termsText") ?? ""));
        return back(page, { ok: "Terms & conditions saved." });
      });
    case "load-terms":
      return run(undefined, async ({ user, form }) => {
        const src = str(form, "source");
        const m = src.match(/^(t|q):([0-9a-f-]{36})$/);
        if (!m) throw Object.assign(new Error("Choose a template or earlier terms first."), { code: "BAD_INPUT" });
        await loadTerms(db(), user, id, m[1] === "t" ? { kind: "template", templateId: m[2] } : { kind: "previous", versionId: m[2] });
        return back(page, { ok: "Terms & conditions replaced. Adjust them for this client if needed, then save." });
      });
    case "add-catalogue":
      return run(undefined, async ({ user, form }) => {
        await addCatalogueLine(db(), user, id, { catalogueCode: str(form, "catalogueCode"), quantity: wholeNumber(str(form, "quantity"), "Quantity"), details: optStr(form, "details") });
        return back(page, { ok: "Item added." });
      });
    case "add-custom":
      return run(undefined, async ({ user, form }) => {
        await addCustomLine(db(), user, id, {
          description: str(form, "description"), details: str(form, "details"), unitLabel: str(form, "unitLabel"),
          quantity: wholeNumber(str(form, "quantity"), "Quantity"), unitPriceSen: ringgitToSen(str(form, "unitPrice"), "Unit price"),
        });
        return back(page, { ok: "Custom item added. Finance will review the amount." });
      });
    case "remove-line":
      return run(undefined, async ({ user, form }) => {
        await removeLine(db(), user, id, str(form, "lineId"));
        return back(page, { ok: "Item removed." });
      });
    case "submit":
      return run(undefined, async ({ user }) => {
        const v = await submitForApproval(db(), user, id);
        return back(page, { ok: `Submitted to Finance (version ${v.version}).` });
      });
    case "recall":
      return run(undefined, async ({ user }) => {
        await recallSubmission(db(), user, id);
        return back(page, { ok: "Recalled. You can edit it again." });
      });
    case "approve":
      return run("quotes.approve", async ({ user, form }) => {
        await approveQuotation(db(), user, id, optStr(form, "note"));
        return back(page, { ok: "Approved. Sales can now download the client PDF." });
      });
    case "reject":
      return run("quotes.approve", async ({ user, form }) => {
        await rejectQuotation(db(), user, id, str(form, "note"));
        return back(page, { ok: "Sent back to Sales with your note." });
      });
    case "revise":
      return run(undefined, async ({ user }) => {
        const v = await reviseQuotation(db(), user, id);
        return back(page, { ok: `Version ${v.version} started from the previous version.` });
      });
    case "cancel":
      return run(undefined, async ({ user, form }) => {
        await cancelQuotation(db(), user, id, str(form, "reason"));
        return back(page, { ok: "Quotation cancelled." });
      });
    default:
      return new Response("Not found", { status: 404 });
  }
}
