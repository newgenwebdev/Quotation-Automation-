import { desc, eq } from "drizzle-orm";
import { commercialPolicies, users } from "@/db/schema";
import { can } from "@/auth/permissions";
import { db, requireUser } from "@/web/server";
import { Messages, Status, fmtDate, fmtDateTime, type Search } from "@/web/ui";

export default async function PolicyPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const sp = await searchParams;
  const all = await db().select().from(commercialPolicies).where(eq(commercialPolicies.code, "DEFAULT")).orderBy(desc(commercialPolicies.version));
  const current = all.find((p) => p.status === "approved");
  const drafts = can(user, "policy.draft") ? all.filter((p) => p.status === "draft") : [];
  const people = Object.fromEntries((await db().select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });

  return (
    <>
      <h1>Payment terms</h1>
      <p className="sub">The only payment milestones, quotation validity and tax that quotations may use.</p>
      <Messages sp={sp} />

      <h2>In force</h2>
      {current ? <PolicyCard p={current} people={people} /> : (
        <div className="panel"><p><strong>No approved payment terms yet.</strong> Until there are, no quotation can be priced.</p></div>
      )}

      {drafts.map((d) => (
        <div key={d.id}>
          <h2>Draft v{d.version}</h2>
          <PolicyCard p={d} people={people} />
          {can(user, "policy.approve") && (
            <form method="post" action={`/api/policy/${d.id}/approve`} className="panel">
              {d.createdBy === user.id && process.env.ALLOW_SELF_APPROVAL !== "true"
                ? <p className="msg warn">You drafted this, so someone else in Finance or Admin must approve it.</p>
                : (<>
                  <label htmlFor={`r-${d.id}`}>Note for the audit log <span className="hint">optional</span></label>
                  <input id={`r-${d.id}`} name="reason" />
                  <p><button type="submit">Approve these terms</button></p>
                </>)}
            </form>
          )}
        </div>
      ))}

      {can(user, "policy.draft") && (
        <>
          <h2>{current ? "Propose new terms" : "Set up payment terms"}</h2>
          <form method="post" action="/api/policy" className="panel">
            <label htmlFor="milestones">Payment milestones <span className="hint">one per line as "Name | percent". Must add up to 100.</span></label>
            <textarea id="milestones" name="milestones" required placeholder={"Deposit on signing | 50\nOn completion | 50"}
              defaultValue={current?.paymentMilestones.map((m) => `${m.label} | ${m.percentBp / 100}`).join("\n") ?? ""} />
            <div className="grid">
              <div>
                <label htmlFor="quoteValidityDays">Quotation valid for (days)</label>
                <input id="quoteValidityDays" name="quoteValidityDays" inputMode="numeric" required defaultValue={current?.quoteValidityDays ?? ""} />
              </div>
              <div>
                <label htmlFor="validFrom">Terms start on</label>
                <input id="validFrom" name="validFrom" type="date" required defaultValue={today} />
              </div>
            </div>
            <label className="row" style={{ fontWeight: 400 }}>
              <input type="checkbox" name="taxEnabled" defaultChecked={current?.taxEnabled ?? false} /> Charge tax on quotations
            </label>
            <div className="grid">
              <div>
                <label htmlFor="taxLabel">Tax name <span className="hint">e.g. SST</span></label>
                <input id="taxLabel" name="taxLabel" defaultValue={current?.taxLabel ?? ""} />
              </div>
              <div>
                <label htmlFor="taxRate">Tax rate (%) <span className="hint">confirm with your accountant</span></label>
                <input id="taxRate" name="taxRate" inputMode="decimal" defaultValue={current?.taxRateBp != null ? current.taxRateBp / 100 : ""} />
              </div>
            </div>
            <p className="muted">Terms &amp; conditions are set per client on each quotation. Standard wording lives under <a href="/terms">T&amp;C templates</a>.</p>
            <p><button type="submit">Save as draft</button></p>
          </form>
        </>
      )}
    </>
  );
}

function PolicyCard({ p, people }: { p: typeof commercialPolicies.$inferSelect; people: Record<string, string> }) {
  return (
    <div className="panel">
      <p><Status status={p.status} /> <span className="muted">v{p.version} · from {fmtDate(p.validFrom)}</span></p>
      <div className="grid">
        <div>
          <label>Payment milestones</label>
          {p.paymentMilestones.length ? <ul className="plain">{p.paymentMilestones.map((m) => <li key={m.label}>{m.label}: {m.percentBp / 100}%</li>)}</ul> : <span className="muted">Not set</span>}
        </div>
        <div><label>Quotation validity</label>{p.quoteValidityDays ? `${p.quoteValidityDays} days` : <span className="muted">Not set</span>}</div>
        <div><label>Tax</label>{p.taxEnabled ? `${p.taxLabel} ${(p.taxRateBp ?? 0) / 100}%` : "No tax charged"}</div>
      </div>
      <p className="muted">Drafted by {people[p.createdBy] ?? "unknown"}{p.approvedBy && ` · approved by ${people[p.approvedBy] ?? "unknown"} on ${fmtDateTime(p.approvedAt)}`}</p>
    </div>
  );
}
