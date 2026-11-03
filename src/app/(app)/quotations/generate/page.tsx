import { listTemplates } from "@/terms/service";
import { quinnConfigured } from "@/quinn/ai";
import { loadTaskForViewer } from "@/quinn/tasks";
import { db, requireUser } from "@/web/server";
import { Messages, one, type Search } from "@/web/ui";

export default async function GeneratePage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("quotes.create");
  const sp = await searchParams;
  const configured = quinnConfigured();
  const templates = await listTemplates(db(), { activeOnly: true });
  const def = templates.find((t) => t.isDefault);
  // "Edit and try again" pre-fills the form from an earlier request.
  const from = one(sp.from);
  const prev = from ? (await loadTaskForViewer(db(), user, from))?.task.input : undefined;

  return (
    <>
      <p><a href="/quotations">← Quotations</a></p>
      <h1>Generate a quotation with Quinn</h1>
      <p className="sub">Describe what the client needs. Quinn drafts the quotation for you to check, price and send to Finance.</p>
      <Messages sp={sp} />
      {!configured && (
        <div className="msg warn">Quinn isn't connected to OpenAI yet. An Admin needs to add <span className="mono">OPENAI_API_KEY</span> in Dokploy before drafts can be generated.</div>
      )}
      <form method="post" action="/api/quinn/draft" className="panel">
        <label htmlFor="description">What does the client need?</label>
        <textarea id="description" name="description" rows={14} required minLength={20} maxLength={20000}
          defaultValue={prev?.description ?? ""}
          placeholder={"Paste discovery notes, a WhatsApp chat or an email. The more detail, the better the draft.\n\ne.g. ABC Trading Sdn Bhd wants a new company website: home, about, 5 product category pages, contact form. Must be bilingual (EN/BM). They also want WhatsApp enquiries to go into Google Sheets. Contact: Mr Tan 012-345 6789."} />
        <div className="grid">
          <div>
            <label htmlFor="clientCompany">Client company <span className="hint">optional; Quinn looks for it in the description</span></label>
            <input id="clientCompany" name="clientCompany" maxLength={200} defaultValue={prev?.clientCompany ?? ""} />
          </div>
          <div>
            <label htmlFor="termsTemplateId">Terms &amp; conditions</label>
            <select id="termsTemplateId" name="termsTemplateId" defaultValue={prev?.termsTemplateId ?? def?.id ?? "none"}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}
              <option value="none">No template (I'll add the terms myself)</option>
            </select>
          </div>
        </div>
        <label htmlFor="extraTerms">Extra terms for this client <span className="hint">optional; added word for word after the template</span></label>
        <textarea id="extraTerms" name="extraTerms" rows={4} maxLength={5000} defaultValue={prev?.extraTerms ?? ""} />
        <div className="msg warn" style={{ marginTop: 14 }}>
          <strong>What Quinn does:</strong> client details, project title, scope, deliverables, exclusions, line items, and questions to ask the client.{" "}
          <strong>What Quinn never does:</strong> set prices or write T&amp;C. Price-list items are priced automatically; you enter prices for everything else, and Finance approves every quotation.
        </div>
        <p><button type="submit" disabled={!configured}>Generate draft</button></p>
        <p className="muted">Your description is sent to OpenAI to prepare the draft.</p>
      </form>
    </>
  );
}
