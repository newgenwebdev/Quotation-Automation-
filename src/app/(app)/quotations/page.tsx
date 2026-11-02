import { and, desc, eq, inArray } from "drizzle-orm";
import { quotations, quotationVersions, users } from "@/db/schema";
import { can } from "@/auth/permissions";
import { db, requireUser } from "@/web/server";
import { Messages, Money, fmtDateTime, one, type Search } from "@/web/ui";
import { QuoteStatus } from "@/web/quote-ui";

const TABS = [
  ["open", "Open"], ["draft", "Drafts"], ["pending_approval", "Waiting for Finance"],
  ["approved", "Approved"], ["rejected", "Sent back"], ["cancelled", "Cancelled"], ["all", "All"],
] as const;

export default async function QuotationsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = (one(sp.tab) ?? "open") as (typeof TABS)[number][0];
  const seeAll = can(user, "quotes.viewAll");

  const statusFilter =
    tab === "open" ? inArray(quotations.status, ["draft", "pending_approval", "rejected", "approved"])
    : tab === "all" ? undefined
    : eq(quotations.status, tab);
  const ownerFilter = seeAll ? undefined : eq(quotations.ownerId, user.id);

  const rows = await db().select({
    q: quotations, ownerName: users.name, totalSen: quotationVersions.totalSen,
  }).from(quotations)
    .innerJoin(users, eq(users.id, quotations.ownerId))
    .innerJoin(quotationVersions, and(eq(quotationVersions.quotationId, quotations.id), eq(quotationVersions.version, quotations.currentVersion)))
    .where(and(statusFilter, ownerFilter))
    .orderBy(desc(quotations.updatedAt)).limit(200);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Quotations</h1>
          <p className="sub">{seeAll ? "All quotations across the team." : "Your quotations."}</p>
        </div>
        {can(user, "quotes.create") && <a className="btn" href="/quotations/new">New quotation</a>}
      </div>
      <Messages sp={sp} />
      <nav className="tabs" aria-label="Filter">
        {TABS.map(([k, l]) => <a key={k} href={`/quotations?tab=${k}`} className={k === tab ? "on" : ""}>{l}</a>)}
      </nav>
      {rows.length === 0 ? (
        <div className="panel">
          <p><strong>No quotations here yet.</strong></p>
          {can(user, "quotes.create") && <p className="muted">Click <strong>New quotation</strong> to start one.</p>}
        </div>
      ) : (
        <table>
          <thead><tr><th>Number</th><th>Client</th><th>Project</th>{seeAll && <th>Owner</th>}<th>Status</th><th className="num">Total</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map(({ q, ownerName, totalSen }) => (
              <tr key={q.id}>
                <td className="mono"><a href={`/quotations/${q.id}`}>{q.number}</a>{q.currentVersion > 1 && <span className="muted"> v{q.currentVersion}</span>}</td>
                <td>{q.clientCompany}</td>
                <td>{q.projectTitle}</td>
                {seeAll && <td>{ownerName}</td>}
                <td><QuoteStatus status={q.status} /></td>
                <td className="num">{totalSen === null ? <span className="muted">not submitted</span> : <Money sen={totalSen} />}</td>
                <td>{fmtDateTime(q.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
