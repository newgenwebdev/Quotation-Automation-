import { desc, eq } from "drizzle-orm";
import { commercialPolicies } from "@/db/schema";
import { userNames } from "@/quotations/service";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";

export default async function PaymentTermsPage({ searchParams }: { searchParams: Search }) {
  await requireUser("policy.manage");
  const sp = await searchParams;
  const all = await db().select().from(commercialPolicies).where(eq(commercialPolicies.code, "DEFAULT")).orderBy(desc(commercialPolicies.version));
  const current = all.find((p) => p.status === "approved");
  const names = await userNames(db(), all.map((p) => p.createdBy));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });

  return (
    <>
      <Messages sp={sp} />
      {current && current.quoteValidityDays !== null && current.quoteValidityDays < 7 && (
        <div className="msg warn">Quotations are currently valid for only {current.quoteValidityDays} day{current.quoteValidityDays === 1 ? "" : "s"}. Most companies use 14–30 days. Check this is intended.</div>
      )}
      <form method="post" action="/api/policy" className="card">
        <div className="card-head">
          <h2>Default payment terms</h2>
          {current && <span className="muted small">Version {current.version} · saved by {names[current.createdBy] ?? "—"} {fmtDateTime(current.approvedAt)}</span>}
        </div>
        <p className="muted">Applied automatically to every new quotation (Quinn and manual). Each quotation can still be changed. Existing quotations keep their own terms.</p>
        <div className="field">
          <label htmlFor="milestones">Payments <span className="hint">· one per line as &quot;Name | percent&quot;, adding up to 100</span></label>
          <textarea id="milestones" name="milestones" rows={4} required placeholder={"Deposit on confirmation | 50\nOn completion | 50"}
            defaultValue={current?.paymentMilestones.map((m) => `${m.label} | ${m.percentBp / 100}`).join("\n") ?? ""} />
        </div>
        <div className="grid-3">
          <div className="field">
            <label htmlFor="quoteValidityDays">Quotation valid for (days)</label>
            <input id="quoteValidityDays" name="quoteValidityDays" inputMode="numeric" required defaultValue={current?.quoteValidityDays ?? 30} />
          </div>
        </div>
        <label className="check" style={{ margin: "6px 0 12px" }}>
          <input type="checkbox" name="taxEnabled" defaultChecked={current?.taxEnabled ?? false} /> Charge tax on new quotations
        </label>
        <div className="grid-3">
          <div className="field"><label htmlFor="taxLabel">Tax name <span className="hint">· e.g. SST</span></label><input id="taxLabel" name="taxLabel" maxLength={40} defaultValue={current?.taxLabel ?? ""} /></div>
          <div className="field"><label htmlFor="taxRate">Tax rate (%) <span className="hint">· confirm with your accountant</span></label><input id="taxRate" name="taxRate" inputMode="decimal" defaultValue={current?.taxRateBp != null ? current.taxRateBp / 100 : ""} /></div>
        </div>
        <input type="hidden" name="validFrom" value={today} />
        <button type="submit">Save payment terms</button>
      </form>
      {all.length > 1 && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Earlier versions</summary>
          <ul style={{ marginTop: 10 }}>
            {all.filter((p) => p.id !== current?.id).map((p) => (
              <li key={p.id}>v{p.version} · {p.paymentMilestones.map((m) => `${m.label} ${m.percentBp / 100}%`).join(", ")} · valid {p.quoteValidityDays ?? "?"} days · {p.taxEnabled ? `${p.taxLabel} ${(p.taxRateBp ?? 0) / 100}%` : "no tax"} <span className="muted">({p.status === "draft" ? "never used" : `saved ${fmtDateTime(p.approvedAt ?? p.createdAt)}`})</span></li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
