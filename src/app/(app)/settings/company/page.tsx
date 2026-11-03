import { loadCompany } from "@/company/service";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";

export default async function CompanyPage({ searchParams }: { searchParams: Search }) {
  await requireUser("company.manage");
  const sp = await searchParams;
  const c = await loadCompany(db());
  return (
    <>
      <Messages sp={sp} />
      <form method="post" action="/api/company" className="card">
        <div className="card-head"><h2>Company profile</h2><span className="muted small">{c.updatedAt.getTime() > 0 ? `Last changed ${fmtDateTime(c.updatedAt)}` : ""}</span></div>
        <p className="muted">Printed at the top of every quotation PDF. The logo is NewGen&apos;s standard logo.</p>
        <div className="grid-2">
          <div className="field span-2"><label htmlFor="name">Company name</label><input id="name" name="name" required maxLength={200} defaultValue={c.name} /></div>
          <div className="field"><label htmlFor="registrationNo">Registration no. <span className="hint">· optional</span></label><input id="registrationNo" name="registrationNo" maxLength={100} defaultValue={c.registrationNo ?? ""} /></div>
          <div className="field"><label htmlFor="phone">Phone <span className="hint">· optional</span></label><input id="phone" name="phone" type="tel" maxLength={50} defaultValue={c.phone ?? ""} /></div>
          <div className="field"><label htmlFor="email">Email <span className="hint">· optional</span></label><input id="email" name="email" type="email" maxLength={200} defaultValue={c.email ?? ""} /></div>
          <div className="field"><label htmlFor="website">Website <span className="hint">· optional</span></label><input id="website" name="website" maxLength={200} defaultValue={c.website ?? ""} /></div>
          <div className="field span-2"><label htmlFor="address">Address</label><textarea id="address" name="address" rows={3} maxLength={500} defaultValue={c.address ?? ""} /></div>
        </div>
        <h3>Bank details for payment <span className="hint" style={{ fontWeight: 400 }}>· printed under Payment terms only when all three are filled in</span></h3>
        <div className="grid-3">
          <div className="field"><label htmlFor="bankName">Bank</label><input id="bankName" name="bankName" maxLength={100} defaultValue={c.bankName ?? ""} /></div>
          <div className="field"><label htmlFor="bankAccountName">Account name</label><input id="bankAccountName" name="bankAccountName" maxLength={200} defaultValue={c.bankAccountName ?? ""} /></div>
          <div className="field"><label htmlFor="bankAccountNo">Account number</label><input id="bankAccountNo" name="bankAccountNo" inputMode="numeric" maxLength={40} defaultValue={c.bankAccountNo ?? ""} /></div>
        </div>
        <button type="submit">Save company profile</button>
      </form>
    </>
  );
}
