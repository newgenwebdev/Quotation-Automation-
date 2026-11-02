import { approveCatalogueItem, retireCatalogueItem, updateCatalogueDraft } from "@/catalogue/service";
import { back, db, formHandler, optStr, str } from "@/web/server";
import { catalogueInputFromForm } from "@/web/catalogue-form";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const page = `/catalogue/${id}`;

  switch (action) {
    case "update":
      return formHandler({ permission: "catalogue.draft", errorPath: page }, async ({ user, form }) => {
        const { code: _code, ...patch } = catalogueInputFromForm(form);
        await updateCatalogueDraft(db(), user, id, patch, "Edited via price list screen");
        return back(page, { ok: "Draft updated." });
      })(req);
    case "approve":
      return formHandler({ permission: "catalogue.approve", errorPath: page }, async ({ user, form }) => {
        const row = await approveCatalogueItem(db(), user, id, optStr(form, "reason") ?? undefined);
        return back(page, { ok: `${row.code} v${row.version} approved. Sales can now quote it.` });
      })(req);
    case "retire":
      return formHandler({ permission: "catalogue.retire", errorPath: page }, async ({ user, form }) => {
        const row = await retireCatalogueItem(db(), user, id, str(form, "reason"));
        return back(page, { ok: `${row.code} v${row.version} retired.` });
      })(req);
    default:
      return new Response("Not found", { status: 404 });
  }
}
