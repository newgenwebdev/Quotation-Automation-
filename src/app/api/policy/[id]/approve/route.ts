import { approvePolicy } from "@/catalogue/service";
import { back, db, formHandler, optStr } from "@/web/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  return formHandler({ permission: "policy.approve", errorPath: "/policy" }, async ({ user, form }) => {
    const row = await approvePolicy(db(), user, id, optStr(form, "reason") ?? undefined);
    return back("/policy", { ok: `Payment terms v${row.version} approved and now in force.` });
  })(req);
}
