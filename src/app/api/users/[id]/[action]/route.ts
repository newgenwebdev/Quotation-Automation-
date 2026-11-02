import { eq } from "drizzle-orm";
import { changeRole, issueResetLink, setActive } from "@/auth/service";
import { users, type Role } from "@/db/schema";
import { back, db, formHandler, isHttps, str } from "@/web/server";
import { withSetupFlash } from "@/web/setup-flash";

type Ctx = { params: Promise<{ id: string; action: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id, action } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const opts = { permission: "users.manage" as const, errorPath: "/users" };

  switch (action) {
    case "role":
      return formHandler(opts, async ({ user, form }) => {
        const u = await changeRole(db(), user, id, str(form, "role") as Role);
        return back("/users", { ok: `${u.name} is now ${u.role}.` });
      })(req);
    case "link":
      return formHandler(opts, async ({ user, req: r }) => {
        const token = await issueResetLink(db(), user, id);
        const [u] = await db().select({ name: users.name }).from(users).where(eq(users.id, id));
        return withSetupFlash(back("/users", { ok: `New link created for ${u.name}. Older links no longer work.` }), u.name, token, isHttps(r));
      })(req);
    case "deactivate":
    case "reactivate":
      return formHandler(opts, async ({ user }) => {
        const u = await setActive(db(), user, id, action === "reactivate");
        return back("/users", { ok: `${u.name} ${u.active ? "reactivated" : "deactivated and signed out"}.` });
      })(req);
    default:
      return new Response("Not found", { status: 404 });
  }
}
