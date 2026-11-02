import { createCatalogueDraft } from "@/catalogue/service";
import { back, db, formHandler } from "@/web/server";
import { catalogueInputFromForm } from "@/web/catalogue-form";

export const POST = formHandler({ permission: "catalogue.draft", errorPath: "/catalogue/new" }, async ({ user, form }) => {
  const row = await createCatalogueDraft(db(), user, catalogueInputFromForm(form));
  return back(`/catalogue/${row.id}`, { ok: `Draft saved as ${row.code} v${row.version}. Another Finance or Admin person can now approve it.` });
});
