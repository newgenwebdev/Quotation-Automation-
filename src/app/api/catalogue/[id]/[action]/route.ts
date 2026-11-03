import { publishCatalogueDraft, retireCatalogueItem } from "@/catalogue/service";
import { back, db, formHandler, str } from "@/web/server";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const page = `/settings/price-list/${id}`;
  const opts = { permission: "catalogue.manage" as const, errorPath: page };
  switch (action) {
    case "publish":
      return formHandler(opts, async ({ user }) => {
        const row = await publishCatalogueDraft(db(), user, id);
        return back(page, { ok: `${row.name} is now in use.` });
      })(req);
    case "retire":
      return formHandler(opts, async ({ user, form }) => {
        const row = await retireCatalogueItem(db(), user, id, str(form, "reason"));
        return back("/settings/price-list", { ok: `${row.name} removed from the price list.` });
      })(req);
    default:
      return new Response("Not found", { status: 404 });
  }
}
