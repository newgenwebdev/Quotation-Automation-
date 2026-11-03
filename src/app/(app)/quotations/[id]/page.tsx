import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { auditLog, catalogueItems, users } from "@/db/schema";
import { can } from "@/auth/permissions";
import { canEdit, computeTotals, describeTerms, loadQuote, previousTermsFor, resolveTermsStatus, splitMilestones } from "@/quotations/service";
import { listTemplates } from "@/terms/service";
import { db, requireUser, senToRinggitInput } from "@/web/server";
import { List, Messages, Money, fmtDate, fmtDateTime, one, type Search } from "@/web/ui";
import { QuoteStatus } from "@/web/quote-ui";
import { describePrice } from "@/web/catalogue-form";

const ACTION_LABEL: Record<string, string> = {
  "quote.created": "Created", "quote.client_updated": "Client details edited", "quote.scope_updated": "Scope edited",
  "quote.line_added": "Line added", "quote.line_removed": "Line removed", "quote.submitted": "Submitted to Finance",
  "quote.recalled": "Recalled to draft", "quote.approved": "Approved by Finance", "quote.rejected": "Sent back by Finance",
  "quote.revised": "New version started", "quote.cancelled": "Cancelled", "quote.pdf_downloaded": "Client PDF downloaded",
  "quote.pdf_preview": "Draft preview opened", "quote.terms_updated": "Terms & conditions edited",
  "quote.terms_loaded": "Terms & conditions replaced", "quote.line_updated": "Line edited",
  "quote.drafted_by_quinn": "Drafted by Quinn",
};

export default async function QuotationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const vParam = one(sp.v);
  const bundle = await loadQuote(db(), user, id, vParam ? Number(vParam) : undefined);
  if (!bundle) notFound();
  const { quotation: q, version: v, lines, versions } = bundle;
  const isCurrent = v.version === q.currentVersion;
  const editable = isCurrent && canEdit(user, q, v);
  const isOwner = q.ownerId === user.id || user.role === "admin";
  const approver = can(user, "quotes.approve");
  const selfBlocked = (v.createdBy === user.id || v.submittedBy === user.id) && process.env.ALLOW_SELF_APPROVAL !== "true";

  const people = Object.fromEntries((await db().select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const priceList = editable
    ? await db().select().from(catalogueItems).where(eq(catalogueItems.status, "approved")).orderBy(asc(catalogueItems.name))
    : [];
  const used = new Set(lines.map((l) => l.catalogueCode).filter(Boolean));
  const history = await db().select().from(auditLog)
    .where(and(eq(auditLog.entityType, "quotation"), eq(auditLog.entityId, q.id), inArray(auditLog.action, Object.keys(ACTION_LABEL))))
    .orderBy(desc(auditLog.id)).limit(50);

  const terms = describeTerms((await resolveTermsStatus(db(), [v])).get(v.id));
  const templates = editable ? await listTemplates(db(), { activeOnly: true }) : [];
  const previousTerms = editable ? await previousTermsFor(db(), user, q) : [];

  const frozen = v.totalSen !== null;
  const unpriced = lines.filter((l) => l.lineTotalSen === null);
  const preview = computeTotals(lines, v.policySnapshot?.tax ?? null);
  const total = frozen ? v.totalSen! : preview.totalSen;
  const base = `/api/quotations/${q.id}`;

  return (
    <>
      <p><a href="/quotations">← Quotations</a></p>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{q.clientCompany}</h1>
          <p className="sub">{q.projectTitle} · <span className="mono">{q.number}</span> · version {v.version} · prepared by {people[q.ownerId]}</p>
        </div>
        <div style={{ textAlign: "right" }}>
          <QuoteStatus status={isCurrent && q.status === "cancelled" ? "cancelled" : v.status === "submitted" ? "pending_approval" : v.status} />
          <div className="big-total"><Money sen={total} /></div>
          {!frozen && <div className="muted" style={{ fontSize: 13 }}>{unpriced.length ? `so far; ${unpriced.length} item${unpriced.length === 1 ? "" : "s"} still need a price` : "preview, before tax"}</div>}
        </div>
      </div>
      <Messages sp={sp} />

      {versions.length > 1 && (
        <nav className="tabs" aria-label="Versions">
          {versions.map((x) => (
            <a key={x.id} href={`/quotations/${q.id}?v=${x.version}`} className={x.version === v.version ? "on" : ""}>v{x.version} · {x.status}</a>
          ))}
        </nav>
      )}

      {/* ---------- Status banners & main actions ---------- */}
      {v.status === "approved" && (
        <div className="panel">
          <p className="msg ok" style={{ marginBottom: 12 }}>
            Approved by {people[v.decidedBy!]} on {fmtDateTime(v.decidedAt)}. Valid until <strong>{fmtDate(v.validUntil)}</strong>.
            {v.decisionNote && <> Note: “{v.decisionNote}”</>}
          </p>
          <div className="actions">
            <a className="btn" href={`/quotations/${q.id}/pdf?v=${v.version}`}>Download PDF for client</a>
            {isCurrent && isOwner && q.status !== "cancelled" && (
              <form method="post" action={`${base}/revise`}><button type="submit" className="secondary">Revise (new version)</button></form>
            )}
          </div>
        </div>
      )}

      {v.status === "rejected" && (
        <div className="panel">
          <p className="msg error" style={{ marginBottom: 12 }}>Sent back by {people[v.decidedBy!]} on {fmtDateTime(v.decidedAt)}: “{v.decisionNote}”</p>
          {isCurrent && isOwner && q.status !== "cancelled" && (
            <form method="post" action={`${base}/revise`}><button type="submit">Make changes (new version)</button></form>
          )}
        </div>
      )}

      {v.status === "submitted" && (
        <div className="panel">
          <p className="msg warn" style={{ marginBottom: 12 }}>Waiting for Finance since {fmtDateTime(v.submittedAt)}. Amounts are locked.</p>
          <div className="actions">
            <a className="btn secondary" href={`/quotations/${q.id}/pdf?v=${v.version}`}>Preview PDF (draft)</a>
            {isOwner && <form method="post" action={`${base}/recall`}><button type="submit" className="secondary">Recall to edit</button></form>}
          </div>
          {approver && (
            <p className={`msg ${terms.review ? "warn" : "ok"}`} style={{ marginTop: 12, marginBottom: 0 }}>
              Terms &amp; conditions: <strong>{terms.label}</strong>.
              {terms.review ? " Please read them below before approving." : ""}
            </p>
          )}
          {approver && (
            selfBlocked
              ? <p className="msg warn" style={{ marginTop: 12 }}>You prepared or submitted this, so another Finance or Admin person must decide.</p>
              : (
                <div className="grid" style={{ marginTop: 12 }}>
                  <form method="post" action={`${base}/approve`}>
                    <label htmlFor="approve-note">Approve <span className="hint">optional note</span></label>
                    <input id="approve-note" name="note" />
                    <p><button type="submit">Approve quotation</button></p>
                  </form>
                  <form method="post" action={`${base}/reject`}>
                    <label htmlFor="reject-note">Send back to Sales <span className="hint">say what to change</span></label>
                    <input id="reject-note" name="note" required minLength={5} />
                    <p><button type="submit" className="danger">Send back</button></p>
                  </form>
                </div>
              )
          )}
        </div>
      )}

      {/* ---------- Quinn's notes (internal, never printed) ---------- */}
      {v.aiNotes && (
        <details className="panel" open={editable}>
          <summary>Drafted by Quinn: check before submitting</summary>
          <p className="muted">Quinn prepared this draft from the description. These notes are for NewGen only and are never printed on the quotation.</p>
          <div className="grid">
            <div><label>Questions to ask the client</label><List items={v.aiNotes.clarificationQuestions} empty="None" /></div>
            <div><label>Information still missing</label><List items={v.aiNotes.missingInformation} empty="None" /></div>
          </div>
          <label>Assumptions Quinn made</label>
          <List items={v.aiNotes.assumptions} empty="None" />
        </details>
      )}

      {/* ---------- Client details ---------- */}
      {editable ? (
        <details className="panel">
          <summary>Client details</summary>
          <form method="post" action={`${base}/header`}>
            <div className="grid">
              <div><label htmlFor="clientCompany">Client company</label><input id="clientCompany" name="clientCompany" defaultValue={q.clientCompany} required /></div>
              <div><label htmlFor="projectTitle">Project title</label><input id="projectTitle" name="projectTitle" defaultValue={q.projectTitle} required /></div>
              <div><label htmlFor="clientContactName">Contact person</label><input id="clientContactName" name="clientContactName" defaultValue={q.clientContactName ?? ""} /></div>
              <div><label htmlFor="clientContactPhone">Phone</label><input id="clientContactPhone" name="clientContactPhone" defaultValue={q.clientContactPhone ?? ""} /></div>
              <div><label htmlFor="clientContactEmail">Email</label><input id="clientContactEmail" name="clientContactEmail" type="email" defaultValue={q.clientContactEmail ?? ""} /></div>
            </div>
            <p><button type="submit" className="secondary">Save client details</button></p>
          </form>
        </details>
      ) : (
        <div className="panel">
          <strong>{q.clientCompany}</strong>
          <div className="muted">{[q.clientContactName, q.clientContactPhone, q.clientContactEmail].filter(Boolean).join(" · ") || "No contact details"}</div>
        </div>
      )}

      {/* ---------- Lines ---------- */}
      <h2>Items</h2>
      {lines.length === 0 ? <div className="panel muted">No items yet. Add one from the price list or as a custom item below.</div> : (
        <table>
          <thead><tr><th>#</th><th>Item</th><th>Qty</th><th className="num">Unit price</th><th className="num">Amount</th>{editable && <th></th>}</tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td>
                  <strong>{l.description}</strong>
                  <span className="muted"> · {l.kind === "catalogue" ? `price list ${l.catalogueCode}` : "custom: needs Finance approval"}</span>
                  {l.details && <div className="muted">{l.details}</div>}
                  {editable && l.kind === "custom" && (
                    <details open={l.lineTotalSen === null} style={{ marginTop: 8 }}>
                      <summary className="muted">{l.lineTotalSen === null ? "Set price" : "Edit"}</summary>
                      <form method="post" action={`${base}/update-line`}>
                        <input type="hidden" name="lineId" value={l.id} />
                        <label htmlFor={`d-${l.id}`}>Description</label>
                        <input id={`d-${l.id}`} name="description" defaultValue={l.description} required minLength={3} />
                        <label htmlFor={`dt-${l.id}`}>Details for the client</label>
                        <input id={`dt-${l.id}`} name="details" defaultValue={l.details ?? ""} />
                        <div className="grid">
                          <div><label htmlFor={`q-${l.id}`}>Quantity</label><input id={`q-${l.id}`} name="quantity" inputMode="numeric" defaultValue={l.quantity} required /></div>
                          <div><label htmlFor={`u-${l.id}`}>Unit</label><input id={`u-${l.id}`} name="unitLabel" defaultValue={l.unitLabel ?? ""} /></div>
                          <div><label htmlFor={`p-${l.id}`}>Unit price (RM)</label><input id={`p-${l.id}`} name="unitPrice" inputMode="decimal" defaultValue={senToRinggitInput(l.unitPriceSen)} required /></div>
                        </div>
                        <p><button type="submit" className="secondary">Save</button></p>
                      </form>
                    </details>
                  )}
                </td>
                <td>{l.quantity}{l.unitLabel ? ` ${l.unitLabel}${l.quantity > 1 ? "s" : ""}` : ""}</td>
                <td className="num">{l.unitPriceSen === null ? "—" : <Money sen={l.unitPriceSen} />}</td>
                <td className="num">{l.lineTotalSen === null ? <span className="badge pending_approval">price needed</span> : <Money sen={l.lineTotalSen} />}</td>
                {editable && (
                  <td><form method="post" action={`${base}/remove-line`}><input type="hidden" name="lineId" value={l.id} /><button type="submit" className="danger">Remove</button></form></td>
                )}
              </tr>
            ))}
            <tr><td colSpan={4}>Subtotal</td><td className="num"><Money sen={frozen ? v.subtotalSen! : preview.subtotalSen} /></td>{editable && <td />}</tr>
            {frozen && v.policySnapshot?.tax && <tr><td colSpan={4}>{v.policySnapshot.tax.label} {v.policySnapshot.tax.rateBp / 100}%</td><td className="num"><Money sen={v.taxSen} /></td>{editable && <td />}</tr>}
            <tr><td colSpan={4}><strong>{frozen ? "Total" : "Total (tax added at submission, if applicable)"}</strong></td><td className="num"><strong><Money sen={total} /></strong></td>{editable && <td />}</tr>
          </tbody>
        </table>
      )}

      {editable && (
        <div className="grid" style={{ marginTop: 16 }}>
          <form method="post" action={`${base}/add-catalogue`} className="panel">
            <h2 style={{ marginTop: 0 }}>Add from price list</h2>
            {priceList.length === 0 ? <p className="muted">No approved prices yet. Use a custom item.</p>
              : priceList.every((p) => used.has(p.code)) ? <p className="muted">Every price-list item is already on this quotation. Use a custom item for anything else.</p> : (
              <>
                <label htmlFor="catalogueCode">Service</label>
                <select id="catalogueCode" name="catalogueCode" required>
                  {priceList.filter((p) => !used.has(p.code)).map((p) => <option key={p.id} value={p.code}>{p.name}: {describePrice(p)}</option>)}
                </select>
                <label htmlFor="cat-qty">Quantity</label>
                <input id="cat-qty" name="quantity" inputMode="numeric" defaultValue="1" required />
                <label htmlFor="cat-details">Details for the client <span className="hint">optional</span></label>
                <input id="cat-details" name="details" placeholder="e.g. Home, About, Services, Contact" />
                <p><button type="submit">Add</button></p>
              </>
            )}
          </form>
          <form method="post" action={`${base}/add-custom`} className="panel">
            <h2 style={{ marginTop: 0 }}>Add custom item</h2>
            <label htmlFor="c-desc">Description</label>
            <input id="c-desc" name="description" required minLength={3} placeholder="e.g. Integration with client's SAP system" />
            <label htmlFor="c-details">Details for the client <span className="hint">optional</span></label>
            <input id="c-details" name="details" />
            <div className="grid">
              <div><label htmlFor="c-qty">Quantity</label><input id="c-qty" name="quantity" inputMode="numeric" defaultValue="1" required /></div>
              <div><label htmlFor="c-unit">Unit <span className="hint">optional</span></label><input id="c-unit" name="unitLabel" placeholder="day, month…" /></div>
              <div><label htmlFor="c-price">Unit price (RM)</label><input id="c-price" name="unitPrice" inputMode="decimal" required /></div>
            </div>
            <p className="muted">Finance reviews every amount before the client sees it.</p>
            <p><button type="submit">Add</button></p>
          </form>
        </div>
      )}

      {/* ---------- Scope ---------- */}
      <h2>Scope</h2>
      {editable ? (
        <form method="post" action={`${base}/scope`} className="panel">
          <label htmlFor="scopeSummary">Scope summary <span className="hint">printed on the quotation</span></label>
          <textarea id="scopeSummary" name="scopeSummary" defaultValue={v.scopeSummary ?? ""} required />
          <div className="grid">
            <div><label htmlFor="deliverables">Deliverables <span className="hint">one per line</span></label><textarea id="deliverables" name="deliverables" defaultValue={v.deliverables.join("\n")} /></div>
            <div><label htmlFor="exclusions">Not included <span className="hint">one per line</span></label><textarea id="exclusions" name="exclusions" defaultValue={v.exclusions.join("\n")} /></div>
          </div>
          <label htmlFor="confirmedTimeline">Confirmed timeline <span className="hint">leave blank unless the timeline is agreed; printed only if filled</span></label>
          <input id="confirmedTimeline" name="confirmedTimeline" defaultValue={v.confirmedTimeline ?? ""} />
          <label htmlFor="internalNotes">Notes for Finance <span className="hint">internal, never printed</span></label>
          <textarea id="internalNotes" name="internalNotes" defaultValue={v.internalNotes ?? ""} />
          <p><button type="submit" className="secondary">Save scope</button></p>
        </form>
      ) : (
        <div className="panel">
          <p style={{ whiteSpace: "pre-wrap" }}>{v.scopeSummary ?? <span className="muted">No scope summary.</span>}</p>
          <div className="grid">
            <div><label>Deliverables</label><List items={v.deliverables} /></div>
            <div><label>Not included</label><List items={v.exclusions} /></div>
          </div>
          {v.confirmedTimeline && (<><label>Confirmed timeline</label><p>{v.confirmedTimeline}</p></>)}
          {v.internalNotes && (<><label>Notes for Finance</label><p style={{ whiteSpace: "pre-wrap" }}>{v.internalNotes}</p></>)}
        </div>
      )}

      {/* ---------- Terms & conditions ---------- */}
      <h2>Terms &amp; conditions</h2>
      {editable ? (
        <div className="panel">
          <p className="muted" style={{ marginTop: 0 }}>{terms.label}.</p>
          {templates.length > 0 || previousTerms.length > 0 ? (
            <form method="post" action={`${base}/load-terms`}>
              <label htmlFor="terms-source">Start from <span className="hint">replaces the text below</span></label>
              <div className="row">
                <select id="terms-source" name="source" required defaultValue="" style={{ flex: 1, width: "auto" }}>
                  <option value="" disabled>Choose a template or this client's earlier terms…</option>
                  {templates.length > 0 && (
                    <optgroup label="T&C templates">
                      {templates.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name}{t.isDefault ? " (default)" : ""}</option>)}
                    </optgroup>
                  )}
                  {previousTerms.length > 0 && (
                    <optgroup label={`Approved before for ${q.clientCompany}`}>
                      {previousTerms.map((p) => <option key={p.versionId} value={`q:${p.versionId}`}>{p.number} v{p.version} · approved {fmtDate(p.decidedAt)}</option>)}
                    </optgroup>
                  )}
                </select>
                <button type="submit" className="secondary">Use these terms</button>
              </div>
            </form>
          ) : (
            <p className="muted">No T&amp;C templates yet. Finance can add them under <strong>T&amp;C templates</strong>, or write the terms below.</p>
          )}
          <form method="post" action={`${base}/terms`}>
            <label htmlFor="termsText">Terms for this client <span className="hint">printed on the quotation; adjust them for this client if needed</span></label>
            <textarea id="termsText" name="termsText" rows={12} defaultValue={v.termsText ?? ""} />
            <p><button type="submit" className="secondary">Save terms</button></p>
          </form>
        </div>
      ) : (
        <div className="panel">
          <p className="muted" style={{ marginTop: 0 }}>{terms.label}.</p>
          {v.termsText ? <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{v.termsText}</p> : null}
        </div>
      )}

      {frozen && v.policySnapshot && (
        <>
          <h2>Payment schedule</h2>
          <table>
            <tbody>
              {splitMilestones(total, v.policySnapshot.paymentMilestones).map((m) => (
                <tr key={m.label}><td>{m.label} ({m.percentBp / 100}%)</td><td className="num"><Money sen={m.amountSen} /></td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ---------- Submit / cancel ---------- */}
      {editable && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="actions">
            <form method="post" action={`${base}/submit`}><button type="submit">Submit to Finance for approval</button></form>
            <a className="btn secondary" href={`/quotations/${q.id}/pdf?v=${v.version}`}>Preview PDF (draft)</a>
          </div>
          {unpriced.length > 0 && <p className="msg warn">Set a price for {unpriced.length === 1 ? "the item" : `the ${unpriced.length} items`} marked "price needed" before submitting.</p>}
          <p className="muted">Once submitted, items, amounts and terms are locked until Finance decides.</p>
        </div>
      )}
      {isCurrent && q.status !== "cancelled" && (isOwner || approver) && (
        <details className="panel">
          <summary>Cancel this quotation</summary>
          <form method="post" action={`${base}/cancel`}>
            <label htmlFor="cancel-reason">Reason</label>
            <div className="row">
              <input id="cancel-reason" name="reason" required minLength={5} placeholder="e.g. Client went with another vendor" style={{ flex: 1 }} />
              <button type="submit" className="danger">Cancel quotation</button>
            </div>
          </form>
        </details>
      )}

      {history.length > 0 && (
        <>
          <h2>History</h2>
          <table>
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Note</th></tr></thead>
            <tbody>{history.map((h) => (
              <tr key={h.id}><td>{fmtDateTime(h.at)}</td><td>{ACTION_LABEL[h.action]}</td><td>{h.actorLabel.split(":")[1] ?? h.actorLabel}</td><td>{h.reason ?? ""}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </>
  );
}
