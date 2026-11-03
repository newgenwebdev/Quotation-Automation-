import { cancelQuotation, duplicateQuotation, markSent, reviseQuotation } from "@/quotations/service";
import { back, db, formHandler, optStr } from "@/web/server";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const page = `/quotations/${id}`;
  const run = (fn: Parameters<typeof formHandler>[1]) => formHandler({ permission: "quotes.create", errorPath: page }, fn)(req);

  switch (action) {
    case "duplicate":
      return run(async ({ user }) => {
        const copy = await duplicateQuotation(db(), user, id);
        return back(`/quotations/${copy.id}`, { ok: `Duplicated as ${copy.number}. Review it, then save.` });
      });
    case "revise":
      return run(async ({ user }) => {
        const v = await reviseQuotation(db(), user, id);
        return back(page, { ok: `Revision ${v.version} started as a draft. The finalised revision is kept as a record.` });
      });
    case "mark-sent":
      return run(async ({ user }) => {
        await markSent(db(), user, id);
        return back(page, { ok: "Marked as sent." });
      });
    case "cancel":
      return run(async ({ user, form }) => {
        await cancelQuotation(db(), user, id, optStr(form, "reason"));
        return back(page, { ok: "Quotation cancelled." });
      });
    default:
      return new Response("Not found", { status: 404 });
  }
}
