import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { auditLog, catalogueItems, users } from "@/db/schema";
import { can } from "@/auth/permissions";
import { db, requireUser } from "@/web/server";
import { List, Messages, Status, fmtDate, fmtDateTime, type Search } from "@/web/ui";
import { CATEGORIES, CatalogueForm, describePrice } from "@/web/catalogue-form";

const ACTION_LABEL: Record<string, string> = {
  "catalogue.draft_created": "Draft created", "catalogue.draft_updated": "Draft edited",
  "catalogue.approved": "Approved", "catalogue.retired": "Retired",
};

export default async function CatalogueItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const user = await requireUser("catalogue.read");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [item] = await db().select().from(catalogueItems).where(eq(catalogueItems.id, id));
  if (!item) notFound();
  // Drafts and retired versions are private to Finance/Admin.
  if (item.status !== "approved" && !can(user, "catalogue.viewDrafts")) notFound();

  const people = Object.fromEntries((await db().select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const versions = can(user, "catalogue.viewDrafts")
    ? await db().select().from(catalogueItems).where(eq(catalogueItems.code, item.code)).orderBy(desc(catalogueItems.version))
    : [];
  const history = can(user, "audit.read")
    ? await db().select().from(auditLog).where(and(eq(auditLog.entityType, "catalogue_item"), eq(auditLog.entityId, id))).orderBy(desc(auditLog.id))
    : [];
  const canEdit = item.status === "draft" && can(user, "catalogue.draft");
  const canApprove = item.status === "draft" && can(user, "catalogue.approve");
  const selfApprovalBlocked = item.createdBy === user.id && process.env.ALLOW_SELF_APPROVAL !== "true";
  const catLabel = Object.fromEntries(CATEGORIES);

  return (
    <>
      <p><a href="/catalogue">← Price list</a></p>
      <h1>{item.name} <span className="muted">v{item.version}</span> <Status status={item.status} /></h1>
      <p className="sub mono">{item.code}</p>
      <Messages sp={sp} />

      <div className="panel">
        <div className="grid">
          <div><label>Price</label>{describePrice(item)}</div>
          <div><label>Category</label>{catLabel[item.category]} · {item.kind === "add_on" ? "Add-on" : "Package"}</div>
          <div><label>Valid</label>{fmtDate(item.validFrom)}{item.validTo ? ` – ${fmtDate(item.validTo)}` : " onwards"}</div>
          <div><label>Revision rounds</label>{item.revisionLimit ?? <span className="muted">Not stated</span>}</div>
        </div>
        <div className="grid">
          <div><label>Included</label><List items={item.inclusions} empty="Not defined yet" /></div>
          <div><label>Not included</label><List items={item.exclusions} empty="Not defined yet" /></div>
        </div>
        <label>Technical review</label>
        {item.alwaysRequiresTechnicalReview && <p>Always required.</p>}
        <List items={item.technicalReviewConditions} empty={item.alwaysRequiresTechnicalReview ? "" : "Not required"} />
        {item.notes && can(user, "catalogue.viewDrafts") && (<><label>Internal notes</label><p>{item.notes}</p></>)}
        <p className="muted">
          Drafted by {people[item.createdBy] ?? "unknown"}
          {item.approvedBy && ` · approved by ${people[item.approvedBy] ?? "unknown"} on ${fmtDateTime(item.approvedAt)}`}
        </p>
      </div>

      {canApprove && (
        <form method="post" action={`/api/catalogue/${item.id}/approve`} className="panel">
          <h2 style={{ marginTop: 0 }}>Approve this price</h2>
          {selfApprovalBlocked ? (
            <p className="msg warn">You drafted this, so someone else in Finance or Admin must approve it.</p>
          ) : (
            <>
              <p className="muted">Once approved it is frozen and Sales can quote it. {versions.some((v) => v.status === "approved") && "The currently approved version will be retired."}</p>
              <label htmlFor="reason">Note for the audit log <span className="hint">optional</span></label>
              <input id="reason" name="reason" placeholder="e.g. Checked against 2027 cost sheet" />
              <p><button type="submit">Approve</button></p>
            </>
          )}
        </form>
      )}

      {item.status === "approved" && can(user, "catalogue.draft") && (
        <div className="panel">
          <div className="row">
            <a className="btn" href={`/catalogue/new?from=${item.id}`}>Change price (new version)</a>
          </div>
          <form method="post" action={`/api/catalogue/${item.id}/retire`} style={{ marginTop: 16 }}>
            <label htmlFor="retire-reason">Withdraw this service <span className="hint">reason required</span></label>
            <div className="row">
              <input id="retire-reason" name="reason" required minLength={5} placeholder="e.g. Service discontinued" style={{ flex: 1 }} />
              <button type="submit" className="danger">Retire</button>
            </div>
          </form>
        </div>
      )}

      {canEdit && (
        <>
          <h2>Edit draft</h2>
          <CatalogueForm action={`/api/catalogue/${item.id}/update`} item={item} lockCode submitLabel="Save changes" />
        </>
      )}

      {versions.length > 1 && (
        <>
          <h2>All versions</h2>
          <table>
            <thead><tr><th>Version</th><th>Price</th><th>Status</th><th>Approved</th></tr></thead>
            <tbody>{versions.map((v) => (
              <tr key={v.id}>
                <td><a href={`/catalogue/${v.id}`}>v{v.version}</a></td>
                <td>{describePrice(v)}</td>
                <td><Status status={v.status} /></td>
                <td>{fmtDateTime(v.approvedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}

      {history.length > 0 && (
        <>
          <h2>History</h2>
          <table>
            <thead><tr><th>When</th><th>What</th><th>Who</th><th>Note</th></tr></thead>
            <tbody>{history.map((h) => (
              <tr key={h.id}><td>{fmtDateTime(h.at)}</td><td>{ACTION_LABEL[h.action] ?? h.action}</td><td>{h.actorLabel}</td><td>{h.reason ?? ""}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </>
  );
}
