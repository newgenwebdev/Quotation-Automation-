import { eq } from "drizzle-orm";
import { issueResetLink, setActive } from "@/auth/service";
import { users } from "@/db/schema";
import { back, db, formHandler, isHttps } from "@/web/server";
import { withSetupFlash } from "@/web/setup-flash";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const opts = { permission: "users.manage" as const, errorPath: "/settings/users" };

  switch (action) {
    case "link":
      return formHandler(opts, async ({ user, req: r }) => {
        const token = await issueResetLink(db(), user, id);
        const [u] = await db().select({ name: users.name }).from(users).where(eq(users.id, id));
        return withSetupFlash(back("/settings/users", { ok: `New link created for ${u.name}. Older links no longer work.` }), u.name, token, isHttps(r));
      })(req);
    case "deactivate":
    case "reactivate":
      return formHandler(opts, async ({ user }) => {
        if (id === user.id) throw Object.assign(new Error("You can't deactivate your own account."), { code: "SELF" });
        const u = await setActive(db(), user, id, action === "reactivate");
        return back("/settings/users", { ok: `${u.name} ${u.active ? "reactivated" : "deactivated and signed out"}.` });
      })(req);
    default:
      return new Response("Not found", { status: 404 });
  }
}
