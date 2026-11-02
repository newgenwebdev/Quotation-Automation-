import { createQuotation } from "@/quotations/service";
import { back, db, formHandler, str } from "@/web/server";

export const POST = formHandler({ permission: "quotes.create", errorPath: "/quotations/new" }, async ({ user, form }) => {
  const q = await createQuotation(db(), user, {
    clientCompany: str(form, "clientCompany"), projectTitle: str(form, "projectTitle"),
    clientContactName: str(form, "clientContactName"), clientContactPhone: str(form, "clientContactPhone"),
    clientContactEmail: str(form, "clientContactEmail"),
  });
  return back(`/quotations/${q.id}`, { ok: `${q.number} created. Now add the items and scope.` });
});
