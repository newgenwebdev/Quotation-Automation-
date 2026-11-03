import { and, asc, eq } from "drizzle-orm";
import { quotations, quotationVersions, users } from "@/db/schema";
import { describeTerms, resolveTermsStatus } from "@/quotations/service";
import { db, requireUser } from "@/web/server";
import { Messages, Money, fmtDateTime, type Search } from "@/web/ui";

export default async function ApprovalsPage({ searchParams }: { searchParams: Search }) {
  await requireUser("quotes.approve");
  const sp = await searchParams;
  const rows = await db().select({ q: quotations, v: quotationVersions, owner: users.name })
    .from(quotations)
    .innerJoin(quotationVersions, and(eq(quotationVersions.quotationId, quotations.id), eq(quotationVersions.version, quotations.currentVersion)))
    .innerJoin(users, eq(users.id, quotations.ownerId))
    .where(eq(quotations.status, "pending_approval"))
    .orderBy(asc(quotationVersions.submittedAt));
  const termsStatus = await resolveTermsStatus(db(), rows.map((r) => r.v));

  return (
    <>
      <h1>Approvals</h1>
      <p className="sub">Quotations waiting for Finance. Oldest first. Every amount must be checked before the client sees it.</p>
      <Messages sp={sp} />
      {rows.length === 0 ? <div className="panel"><strong>Nothing waiting.</strong></div> : (
        <table>
          <thead><tr><th>Number</th><th>Client</th><th>Project</th><th>From</th><th>T&amp;C</th><th>Submitted</th><th className="num">Total</th></tr></thead>
          <tbody>
            {rows.map(({ q, v, owner }) => {
              const t = describeTerms(termsStatus.get(v.id));
              return (
              <tr key={q.id}>
                <td className="mono"><a href={`/quotations/${q.id}`}>{q.number}</a> <span className="muted">v{v.version}</span></td>
                <td>{q.clientCompany}</td>
                <td>{q.projectTitle}</td>
                <td>{owner}</td>
                <td title={t.label}>{t.review ? <strong>{t.short}</strong> : <span className="muted">{t.short}</span>}</td>
                <td>{fmtDateTime(v.submittedAt)}</td>
                <td className="num"><Money sen={v.totalSen} /></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
