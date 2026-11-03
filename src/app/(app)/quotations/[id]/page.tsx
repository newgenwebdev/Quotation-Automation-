import { notFound } from "next/navigation";
import { and, desc, eq, inArray } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { canEdit, loadQuote, previousTermsFor, reviewBundle, userNames, type QuoteBundle } from "@/quotations/service";
import { computeTotals, percentLabel, quantityText, splitMilestones } from "@/quotations/calc";
import { db, requireUser } from "@/web/server";
import { List, Messages, Money, fmtDate, fmtDateTime, one, type Search } from "@/web/ui";
import { QuoteStatus } from "@/web/quote-ui";
import { QuoteEditor } from "@/web/editor/QuoteEditor";
import { stateFromSaved } from "@/web/editor/model";
import { editorContext } from "@/web/editor/context";

const ACTION_LABEL: Record<string, string> = {
  "quote.created": "Created", "quote.saved": "Saved", "quote.finalised": "Finalised", "quote.sent": "Marked as sent",
  "quote.revised": "New revision started", "quote.duplicated": "Duplicated", "quote.cancelled": "Cancelled",
  "quote.pdf_downloaded": "PDF downloaded", "quote.pdf_preview": "Draft preview opened", "quote.drafted_by_quinn": "Drafted by Quinn",
  "quote.status_migrated": "Status updated (workflow simplified)",
  // Before the redesign:
  "quote.client_updated": "Client details edited", "quote.scope_updated": "Scope edited", "quote.line_added": "Line added",
  "quote.line_removed": "Line removed", "quote.line_updated": "Line edited", "quote.submitted": "Submitted to Finance",
  "quote.recalled": "Recalled to draft", "quote.approved": "Approved by Finance", "quote.rejected": "Sent back by Finance",
  "quote.terms_updated": "Terms edited", "quote.terms_loaded": "Terms replaced",
};

export const metadata = { title: "Quotation · NewGen" };

export default async function QuotationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const user = await requireUser("quotes.create");
  const { id } = await params;
  const sp = await searchParams;
  const vParam = one(sp.v);
  const bundle = await loadQuote(db(), user, id, vParam && /^\d+$/.test(vParam) ? Number(vParam) : undefined);
  if (!bundle) notFound();
  const { quotation: q, version: v, lines } = bundle;
  const names = await userNames(db(), [q.ownerId, v.finalisedBy, v.createdBy]);

  if (canEdit(user, q, v)) {
    const ctx = await editorContext(db());
    const prev = await previousTermsFor(db(), user, q.clientCompany, q.id);
    return (
      <QuoteEditor
        key={`${q.id}-${v.version}`}
        initial={stateFromSaved(q, v, lines, ctx.defaults)} createdBy={names[q.ownerId] ?? null}
        priceList={ctx.priceList} templates={ctx.templates}
        previousTerms={prev.map((p) => ({ versionId: p.versionId, label: `${p.number}${p.version > 1 ? ` rev ${p.version}` : ""}${p.finalisedAt ? ` · ${fmtDate(p.finalisedAt)}` : ""}`, termsText: p.termsText ?? "" }))}
        aiNotes={v.aiNotes} validityDays={ctx.validityDays} today={ctx.today} flash={one(sp.ok) ?? null}
      />
    );
  }
  return <QuoteView bundle={bundle} names={names} sp={sp} />;
}

async function QuoteView({ bundle, names, sp }: { bundle: QuoteBundle; names: Record<string, string>; sp: Record<string, string | string[] | undefined> }) {
  const { quotation: q, version: v, lines, versions } = bundle;
  const isCurrent = v.version === q.currentVersion;
  const base = `/api/quotations/${q.id}`;
  const discount = v.discountType ? { type: v.discountType, value: v.discountValue ?? 0, label: v.discountLabel } : null;
  const tax = v.taxRateBp !== null && v.taxLabel ? { label: v.taxLabel, rateBp: v.taxRateBp } : null;
  const live = computeTotals(lines, discount, tax);
  const totals = v.totalSen !== null && v.subtotalSen !== null
    ? { subtotalSen: v.subtotalSen, discountSen: v.discountSen ?? 0, taxSen: v.taxSen ?? 0, totalSen: v.totalSen } : live;
  const status = isCurrent ? q.status : v.status;
  const warnings = v.status === "finalised" && isCurrent && q.status !== "cancelled" ? reviewBundle(bundle).warnings.filter((w) => !w.startsWith("The quotation date is in the past")) : [];
  const history = await db().select().from(auditLog)
    .where(and(eq(auditLog.entityType, "quotation"), eq(auditLog.entityId, q.id), inArray(auditLog.action, Object.keys(ACTION_LABEL))))
    .orderBy(desc(auditLog.id)).limit(60);

  return (
    <>
      <a className="back" href="/quotations">← Quotations</a>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 22 }}>{q.number}</h1>
          <p className="sub">
            <QuoteStatus status={status} />{" "}
            {v.version > 1 && <>Revision {v.version} · </>}Created by {names[q.ownerId] ?? "—"}
            {v.finalisedAt && <> · Finalised {fmtDateTime(v.finalisedAt)}{v.finalisedBy && names[v.finalisedBy] ? ` by ${names[v.finalisedBy]}` : ""}</>}
            {isCurrent && q.sentAt && <> · Sent {fmtDateTime(q.sentAt)}</>}
          </p>
        </div>
        <div className="actions">
          <a className="btn" href={`/quotations/${q.id}/pdf?v=${v.version}`}>Download PDF</a>
          <a className="btn secondary" href={`/quotations/${q.id}/pdf?v=${v.version}&inline=1`} target="_blank" rel="noopener">Preview</a>
          {isCurrent && q.status === "finalised" && (
            <form method="post" action={`${base}/mark-sent`}><button type="submit" className="secondary">Mark as sent</button></form>
          )}
          {isCurrent && (q.status === "finalised" || q.status === "sent") && (
            <form method="post" action={`${base}/revise`}><button type="submit" className="secondary" title="Starts a new draft revision; this one stays as a record">Edit</button></form>
          )}
          <form method="post" action={`${base}/duplicate`}><button type="submit" className="secondary">Duplicate</button></form>
        </div>
      </div>
      <Messages sp={sp} />
      {!isCurrent && <div className="msg info">This is an older revision, kept as a record. <a href={`/quotations/${q.id}`}>Open the current revision</a>.</div>}
      {q.status === "cancelled" && isCurrent && <div className="msg warn">This quotation was cancelled. Its PDF is marked “CANCELLED”. Use Duplicate to start a new one from it.</div>}
      {warnings.length > 0 && (
        <div className="msg warn"><strong>Please double-check before sending:</strong><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
      )}

      {versions.length > 1 && (
        <nav className="tabs" aria-label="Revisions" style={{ marginBottom: 14, width: "fit-content" }}>
          {versions.map((x) => (
            <a key={x.id} href={`/quotations/${q.id}?v=${x.version}`} aria-current={x.version === v.version ? "page" : undefined}>
              Revision {x.version} · {x.version === q.currentVersion ? (q.status === "cancelled" ? "cancelled" : q.status) : x.status === "superseded" ? "replaced" : x.status}
            </a>
          ))}
        </nav>
      )}

      <article className="card doc" aria-label="Quotation">
        <div className="doc-head">
          <div>
            <div className="cap">Prepared for</div>
            <p style={{ fontWeight: 650, fontSize: 16, marginBottom: 2 }}>{q.clientCompany}</p>
            <div className="muted">{[q.clientContactName, q.clientContactEmail, q.clientContactPhone].filter(Boolean).join(" · ")}</div>
            {q.clientAddress && <div className="muted pre small">{q.clientAddress}</div>}
            <div className="cap" style={{ marginTop: 12 }}>Project</div>
            <p style={{ fontWeight: 600, margin: 0 }}>{q.projectTitle}</p>
          </div>
          <dl className="kv">
            <dt>Quotation No.</dt><dd className="mono">{q.number}</dd>
            <dt>Date</dt><dd>{fmtDate(v.quoteDate)}</dd>
            <dt>Valid until</dt><dd>{fmtDate(v.validUntil)}</dd>
            <dt>Total</dt><dd><Money sen={totals.totalSen} /></dd>
          </dl>
        </div>

        {v.scopeSummary && (<><h3>Project overview</h3><p className="pre">{v.scopeSummary}</p></>)}
        {v.objectives.length > 0 && (<><h3>Objectives</h3><List items={v.objectives} /></>)}
        {(v.services.length > 0 || v.features.length > 0 || v.technicalRequirements.length > 0) && (
          <>
            <h3>Scope of work</h3>
            <div className="grid-2">
              {v.services.length > 0 && <div><div className="label">Services included</div><List items={v.services} /></div>}
              {v.features.length > 0 && <div><div className="label">Features and functionalities</div><List items={v.features} /></div>}
              {v.technicalRequirements.length > 0 && <div><div className="label">Technical requirements</div><List items={v.technicalRequirements} /></div>}
            </div>
          </>
        )}
        {(v.deliverables.length > 0 || v.exclusions.length > 0) && (
          <div className="grid-2">
            {v.deliverables.length > 0 && <div><h3>Deliverables</h3><List items={v.deliverables} /></div>}
            {v.exclusions.length > 0 && <div><h3>Exclusions</h3><List items={v.exclusions} /></div>}
          </div>
        )}

        <h3>Pricing</h3>
        <div className="table-wrap" style={{ boxShadow: "none" }}>
          <table className="stack">
            <thead><tr><th style={{ width: 36 }}>#</th><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="muted hide-md">{i + 1}</td>
                  <td className="lead"><strong>{l.description}</strong>{l.details && <div className="cell-sub">{l.details}</div>}</td>
                  <td className="num nowrap" data-label="Qty">{quantityText(l.quantity, l.unitLabel)}</td>
                  <td className="num nowrap" data-label="Unit price"><Money sen={l.unitPriceSen} /></td>
                  <td className="num nowrap" data-label="Amount">{l.lineTotalSen === null ? <span className="badge review">Price review</span> : <Money sen={l.lineTotalSen} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals">
          <div className="t"><span>Subtotal</span><span><Money sen={totals.subtotalSen} /></span></div>
          {totals.discountSen > 0 && <div className="t"><span>{v.discountLabel || "Discount"}{v.discountType === "percent" ? ` (${percentLabel(v.discountValue ?? 0)})` : ""}</span><span>- <Money sen={totals.discountSen} /></span></div>}
          {tax && <div className="t"><span>{tax.label} ({percentLabel(tax.rateBp)})</span><span><Money sen={totals.taxSen} /></span></div>}
          <div className="t grand"><span>Total (MYR)</span><span><Money sen={totals.totalSen} /></span></div>
        </div>

        {(v.timelineDuration || v.timelineMilestones.length > 0) && (
          <>
            <h3>Project timeline</h3>
            {v.timelineDuration && <p>Estimated duration: <strong>{v.timelineDuration}</strong></p>}
            {v.timelineMilestones.length > 0 && <ul>{v.timelineMilestones.map((m, i) => <li key={i}>{m.label}{m.timing && <span className="muted"> · {m.timing}</span>}</li>)}</ul>}
          </>
        )}
        {(v.paymentMilestones.length > 0 || v.paymentNotes) && (
          <>
            <h3>Payment terms</h3>
            {v.paymentMilestones.length > 0 && (
              <ul>{splitMilestones(totals.totalSen, v.paymentMilestones).map((m, i) => <li key={i}>{m.label} ({percentLabel(m.percentBp)}): <strong><Money sen={m.amountSen} /></strong></li>)}</ul>
            )}
            {v.paymentNotes && <p className="pre">{v.paymentNotes}</p>}
          </>
        )}
        {(v.termsText || v.projectTerms || v.assumptions.length > 0) && (
          <>
            <h3>Terms and conditions</h3>
            {v.validUntil && <p>This quotation is valid until {fmtDate(v.validUntil)}.</p>}
            {v.termsText && <p className="pre small">{v.termsText}</p>}
            {v.projectTerms && <><div className="label">Project-specific terms</div><p className="pre small">{v.projectTerms}</p></>}
            {v.assumptions.length > 0 && <><div className="label">Assumptions</div><List items={v.assumptions} /></>}
          </>
        )}
      </article>

      {(v.internalNotes || v.aiNotes) && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Internal notes <span className="hint">(never printed)</span></summary>
          {v.internalNotes && <p className="pre" style={{ marginTop: 10 }}>{v.internalNotes}</p>}
          {v.aiNotes && (
            <div className="grid" style={{ marginTop: 10 }}>
              <div><div className="label">Questions Quinn suggested</div><List items={v.aiNotes.clarificationQuestions} empty="None" /></div>
              <div><div className="label">Missing information Quinn flagged</div><List items={v.aiNotes.missingInformation} empty="None" /></div>
            </div>
          )}
        </details>
      )}

      {isCurrent && q.status !== "cancelled" && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>Cancel this quotation</summary>
          <form method="post" action={`${base}/cancel`} style={{ marginTop: 12 }}>
            <label htmlFor="cancel-reason">Reason <span className="hint">optional, kept in the history</span></label>
            <div className="row">
              <input id="cancel-reason" name="reason" maxLength={300} placeholder="e.g. Client went with another vendor" style={{ flex: 1, minWidth: 220 }} />
              <button type="submit" className="danger">Cancel quotation</button>
            </div>
          </form>
        </details>
      )}

      {history.length > 0 && (
        <details className="card">
          <summary style={{ cursor: "pointer", fontWeight: 650 }}>History</summary>
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table>
              <thead><tr><th>When</th><th>What</th><th>Who</th><th>Note</th></tr></thead>
              <tbody>{history.map((h) => (
                <tr key={h.id}><td className="nowrap">{fmtDateTime(h.at)}</td><td>{ACTION_LABEL[h.action]}</td><td>{h.actorLabel.split(":").slice(1).join(":") || h.actorLabel}</td><td>{h.reason ?? ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
