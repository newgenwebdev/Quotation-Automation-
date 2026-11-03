import { QUOTE_STATUSES, type QuoteStatus as Status } from "@/db/schema";
import { listQuotations } from "@/quotations/service";
import { db, requireUser } from "@/web/server";
import { Icon, Messages, Money, fmtRelative, one, type Search } from "@/web/ui";
import { QuoteStatus, QUOTE_STATUS_LABEL } from "@/web/quote-ui";

export default async function QuotationsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("quotes.create");
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").slice(0, 100);
  const statusParam = one(sp.status);
  const status = (QUOTE_STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as Status) : "all";
  const rows = await listQuotations(db(), user, { search: q, status });
  const href = (s: string) => `/quotations?${new URLSearchParams({ ...(q ? { q } : {}), ...(s !== "all" ? { status: s } : {}) })}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <p className="sub">Create a client-ready quotation in minutes, with Quinn or by hand.</p>
        </div>
      </div>
      <Messages sp={sp} />

      <div className="hero-actions">
        <a className="hero primary" href="/quotations/generate">
          <span className="ico"><Icon name="spark" size={20} /></span>
          <span><strong>Generate with Quinn</strong><span>Paste a WhatsApp chat, email or meeting notes. Quinn writes and prices the quotation.</span></span>
        </a>
        <a className="hero" href="/quotations/new">
          <span className="ico"><Icon name="pencil" size={20} /></span>
          <span><strong>Generate manually</strong><span>Fill in one structured form, top to bottom, then preview and export.</span></span>
        </a>
      </div>

      <div className="toolbar">
        <form method="get" action="/quotations" role="search">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <label htmlFor="q" className="sr-only">Search quotations</label>
          <input id="q" name="q" type="search" defaultValue={q} placeholder="Search number, client or project" />
          <button type="submit" className="secondary">Search</button>
        </form>
        <nav className="tabs" aria-label="Filter by status">
          {(["all", ...QUOTE_STATUSES] as const).map((s) => (
            <a key={s} href={href(s)} aria-current={s === status ? "page" : undefined}>{s === "all" ? "All" : QUOTE_STATUS_LABEL[s]}</a>
          ))}
        </nav>
      </div>

      {rows.length === 0 ? (
        <div className="card empty">
          <h2>{q || status !== "all" ? "No quotations match" : "No quotations yet"}</h2>
          <p>{q || status !== "all" ? <a href="/quotations">Clear the search and filters</a> : "Start with Generate with Quinn or Generate manually above."}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th style={{ width: 128 }}>Quotation No.</th><th>Client company</th><th>Project title</th><th style={{ width: 112 }}>Created by</th>
                <th className="num" style={{ width: 130 }}>Total amount</th><th style={{ width: 104 }}>Status</th><th style={{ width: 112 }}>Last updated</th><th style={{ width: 132 }}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="lead" data-label="Quotation No.">
                    <a className="title mono" href={`/quotations/${r.id}`}>{r.number}</a>
                    {r.currentVersion > 1 && <div className="cell-sub">Revision {r.currentVersion}</div>}
                  </td>
                  <td data-label="Client"><span className="clamp">{r.clientCompany}</span></td>
                  <td data-label="Project"><span className="clamp">{r.projectTitle}</span></td>
                  <td data-label="Created by">{r.createdBy}</td>
                  <td className="num" data-label="Total">
                    <span>
                      <Money sen={r.totalSen} />
                      {r.unpriced > 0 && r.status === "draft" && <><br /><span className="badge review">{r.unpriced} to price</span></>}
                    </span>
                  </td>
                  <td data-label="Status"><QuoteStatus status={r.status} /></td>
                  <td data-label="Last updated" className="nowrap" title={r.updatedAt.toISOString()}>{fmtRelative(r.updatedAt)}</td>
                  <td data-label="Actions">
                    <div className="actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <a className="btn sm secondary" href={`/quotations/${r.id}`}>{r.status === "draft" ? "Edit" : "View"}</a>
                      <a className="icon-link" href={`/quotations/${r.id}/pdf`} title="Download PDF" aria-label={`Download PDF of ${r.number}`}><Icon name="download" size={17} /></a>
                      <form method="post" action={`/api/quotations/${r.id}/duplicate`}>
                        <button type="submit" className="icon-link" title="Duplicate as a new quotation" aria-label={`Duplicate ${r.number}`}><Icon name="copy" size={17} /></button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>{rows.length === 300 ? "Showing the 300 most recently updated. Use search to find older ones." : `${rows.length} quotation${rows.length === 1 ? "" : "s"}`}</p>
    </>
  );
}
