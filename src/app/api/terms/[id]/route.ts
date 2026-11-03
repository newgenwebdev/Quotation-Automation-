import { updateTemplate } from "@/terms/service";
import { back, db, formHandler, optStr, str } from "@/web/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  return formHandler({ permission: "terms.manage", errorPath: `/terms/${id}` }, async ({ user, form }) => {
    const t = await updateTemplate(db(), user, id, {
      name: str(form, "name"), body: String(form.get("body") ?? ""),
      isDefault: form.get("isDefault") === "on", active: form.get("active") === "on",
    }, optStr(form, "reason") ?? undefined);
    return back("/terms", { ok: `Template "${t.name}" updated.` });
  })(req);
}
