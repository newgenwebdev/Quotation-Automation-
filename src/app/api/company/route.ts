import { saveCompany } from "@/company/service";
import { back, db, formHandler, str } from "@/web/server";

export const POST = formHandler({ permission: "company.manage", errorPath: "/settings/company" }, async ({ user, form }) => {
  await saveCompany(db(), user, {
    name: str(form, "name"), registrationNo: str(form, "registrationNo"), address: String(form.get("address") ?? "").trim(),
    phone: str(form, "phone"), email: str(form, "email"), website: str(form, "website"),
    bankName: str(form, "bankName"), bankAccountName: str(form, "bankAccountName"), bankAccountNo: str(form, "bankAccountNo"),
  });
  return back("/settings/company", { ok: "Company profile saved. New PDFs use it straight away." });
});
