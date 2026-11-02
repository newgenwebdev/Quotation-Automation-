import { createUser } from "@/auth/service";
import { back, db, formHandler, isHttps, str } from "@/web/server";
import { withSetupFlash } from "@/web/setup-flash";
import type { Role } from "@/db/schema";

export const POST = formHandler({ permission: "users.manage", errorPath: "/users" }, async ({ user, form, req }) => {
  const { user: created, setupToken } = await createUser(db(), user, {
    email: str(form, "email"), name: str(form, "name"), role: str(form, "role") as Role,
  });
  return withSetupFlash(back("/users", { ok: `${created.name} added as ${created.role}.` }), created.name, setupToken, isHttps(req));
});
