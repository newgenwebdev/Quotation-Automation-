import { saveCatalogueItem } from "@/catalogue/service";
import { back, db, formHandler } from "@/web/server";
import { catalogueInputFromForm } from "@/web/catalogue-form";

export const POST = formHandler({ permission: "catalogue.manage", errorPath: "/settings/price-list/new" }, async ({ user, form }) => {
  const row = await saveCatalogueItem(db(), user, catalogueInputFromForm(form));
  return back(`/settings/price-list/${row.id}`, { ok: `${row.name} saved${row.version > 1 ? ` (version ${row.version})` : ""}. It's used for new quotations from now on.` });
});
