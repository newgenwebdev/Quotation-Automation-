import { requireUser } from "@/web/server";
import { Messages, type Search } from "@/web/ui";

export default async function NewQuotationPage({ searchParams }: { searchParams: Search }) {
  await requireUser("quotes.create");
  const sp = await searchParams;
  return (
    <>
      <p><a href="/quotations">← Quotations</a></p>
      <h1>New quotation</h1>
      <p className="sub">Start with the client and project. You'll add the items and scope on the next screen.</p>
      <Messages sp={sp} />
      <form method="post" action="/api/quotations" className="panel">
        <div className="grid">
          <div><label htmlFor="clientCompany">Client company</label><input id="clientCompany" name="clientCompany" required /></div>
          <div><label htmlFor="projectTitle">Project title</label><input id="projectTitle" name="projectTitle" required placeholder="e.g. Corporate website revamp" /></div>
          <div><label htmlFor="clientContactName">Contact person <span className="hint">optional</span></label><input id="clientContactName" name="clientContactName" /></div>
          <div><label htmlFor="clientContactPhone">Phone <span className="hint">optional</span></label><input id="clientContactPhone" name="clientContactPhone" inputMode="tel" /></div>
          <div><label htmlFor="clientContactEmail">Email <span className="hint">optional</span></label><input id="clientContactEmail" name="clientContactEmail" type="email" /></div>
        </div>
        <p><button type="submit">Create quotation</button></p>
      </form>
    </>
  );
}
