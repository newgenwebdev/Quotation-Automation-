import { createTemplate } from "@/terms/service";
import { back, db, formHandler, str } from "@/web/server";

export const POST = formHandler({ permission: "terms.manage", errorPath: "/settings/terms" }, async ({ user, form }) => {
  const t = await createTemplate(db(), user, {
    name: str(form, "name"), body: String(form.get("body") ?? ""), isDefault: form.get("isDefault") === "on",
  });
  return back("/settings/terms", { ok: `Template "${t.name}" saved.${t.isDefault ? " New quotations will start with it." : ""}` });
});
