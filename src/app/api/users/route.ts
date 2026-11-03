import { createUser } from "@/auth/service";
import { back, db, formHandler, isHttps, str } from "@/web/server";
import { withSetupFlash } from "@/web/setup-flash";

export const POST = formHandler({ permission: "users.manage", errorPath: "/settings/users" }, async ({ user, form, req }) => {
  const { user: created, setupToken } = await createUser(db(), user, { email: str(form, "email"), name: str(form, "name") });
  return withSetupFlash(back("/settings/users", { ok: `${created.name} added.` }), created.name, setupToken, isHttps(req));
});
