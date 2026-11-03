import { quinnConfigured } from "@/quinn/ai";
import { MAX_DESCRIPTION, loadTaskForViewer } from "@/quinn/tasks";
import { newQuoteDefaults } from "@/quotations/service";
import { activePriceList } from "@/catalogue/service";
import { todayKL } from "@/quotations/calc";
import { db, requireUser } from "@/web/server";
import { Icon, Messages, one, type Search } from "@/web/ui";

export const metadata = { title: "Generate with Quinn · NewGen" };

export default async function GeneratePage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("quotes.create");
  const sp = await searchParams;
  const configured = quinnConfigured();
  // "Edit and try again" pre-fills the form from an earlier request.
  const from = one(sp.from);
  const prev = from ? (await loadTaskForViewer(db(), user, from))?.task.input : undefined;
  const [defaults, priceList] = await Promise.all([newQuoteDefaults(db()), activePriceList(db(), todayKL())]);

  return (
    <>
      <a className="back" href="/quotations">← Quotations</a>
      <div className="page-head">
        <div>
          <h1>Generate with Quinn</h1>
          <p className="sub">Paste the client&apos;s requirements. Quinn writes the full quotation and prices it from your price list, then opens it for you to review.</p>
        </div>
      </div>
      <Messages sp={sp} />
      {!configured && (
        <div className="msg warn">Quinn isn&apos;t connected to OpenAI yet. An Admin needs to add <span className="mono">OPENAI_API_KEY</span> in Dokploy.</div>
      )}
      <form method="post" action="/api/quinn/draft" className="card">
        <div className="field">
          <label htmlFor="description">Client requirements</label>
          <textarea id="description" name="description" rows={16} required minLength={20} maxLength={MAX_DESCRIPTION}
            defaultValue={prev?.description ?? ""}
            placeholder={"Paste a WhatsApp chat, client email, meeting notes or scope of work. Any language is fine.\n\ne.g. Hi, we're ABC Trading Sdn Bhd. We need a new company website: home, about, 5 product pages and a contact form, in English and BM. Can enquiries go into Google Sheets? Contact Mr Tan 012-345 6789."} />
          <p className="muted small" style={{ marginTop: 6 }}>Up to {MAX_DESCRIPTION.toLocaleString()} characters, so long chat exports are fine. Remove anything unrelated to this project.</p>
        </div>
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="clientCompany">Client company <span className="hint">· optional; Quinn looks for it in the text</span></label>
          <input id="clientCompany" name="clientCompany" maxLength={200} defaultValue={prev?.clientCompany ?? ""} autoComplete="organization" />
        </div>
        <div className="msg info" style={{ marginTop: 6 }}>
          <strong>Applied automatically from Settings:</strong>{" "}
          {priceList.length ? `${priceList.length} price-list item${priceList.length === 1 ? "" : "s"}` : "no price list yet (every item will need a price review)"} ·{" "}
          {defaults.paymentMilestones.length ? `payment terms ${defaults.paymentMilestones.map((m) => `${m.percentBp / 100}%`).join(" / ")}` : "no default payment terms yet"} ·{" "}
          {defaults.terms.text ? "default T&C template" : "no default T&C template yet"} · valid for {defaults.validityDays} day{defaults.validityDays === 1 ? "" : "s"}.
          {" "}Quinn never invents prices: anything not on the price list is marked <em>Price review required</em>.
        </div>
        <div className="actions" style={{ marginTop: 4 }}>
          <button type="submit" className="lg" disabled={!configured}><Icon name="spark" /> Generate quotation</button>
          <a className="btn secondary lg" href="/quotations/new">Fill it in manually instead</a>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>The text you paste is sent to OpenAI to prepare the quotation (not stored by OpenAI).</p>
      </form>
    </>
  );
}
