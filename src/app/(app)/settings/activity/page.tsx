import { desc } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { fmtDateTime } from "@/web/ui";

const LABEL: Record<string, string> = {
  "quote.created": "Quotation created", "quote.saved": "Quotation saved", "quote.finalised": "Quotation finalised",
  "quote.sent": "Quotation marked as sent", "quote.revised": "Quotation revision started", "quote.duplicated": "Quotation duplicated",
  "quote.cancelled": "Quotation cancelled", "quote.pdf_downloaded": "PDF downloaded", "quote.pdf_preview": "Draft PDF previewed",
  "quote.drafted_by_quinn": "Drafted by Quinn", "quinn.draft_requested": "Quinn asked for a quotation", "quote.status_migrated": "Status updated (workflow simplified)",
  "catalogue.saved": "Price saved", "catalogue.retired": "Price replaced / removed", "catalogue.published": "Price put into use",
  "policy.saved": "Payment terms saved", "policy.retired": "Payment terms replaced", "terms.template_created": "T&C template added", "terms.template_updated": "T&C template changed",
  "company.updated": "Company profile changed", "user.created": "User added", "user.role_changed": "Role changed", "user.password_set": "Password set",
  "user.setup_link_issued": "Setup link created", "user.deactivated": "User deactivated", "user.reactivated": "User reactivated", "user.locked": "Locked after failed sign-ins",
  "system.workflow_simplified": "System updated: single role, no Finance approval",
};

export default async function ActivityPage() {
  await requireUser("audit.read");
  const rows = await db().select({
    id: auditLog.id, at: auditLog.at, actorLabel: auditLog.actorLabel, action: auditLog.action,
    entityType: auditLog.entityType, entityId: auditLog.entityId, reason: auditLog.reason,
  }).from(auditLog).orderBy(desc(auditLog.id)).limit(200);

  return (
    <div className="card">
      <h2>Activity log</h2>
      <p className="muted">Every change to quotations, prices, payment terms, T&amp;C, company details and users. Entries can&apos;t be edited or deleted. Showing the latest 200.</p>
      <div className="table-wrap" style={{ boxShadow: "none" }}>
        <table className="stack">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Note</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="lead nowrap">{fmtDateTime(r.at)}</td>
                <td data-label="Who">{r.actorLabel.includes(":") ? r.actorLabel.split(":").slice(1).join(":") : r.actorLabel}</td>
                <td data-label="What">
                  {r.entityType === "quotation" ? <a href={`/quotations/${r.entityId}`}>{LABEL[r.action] ?? r.action}</a>
                    : r.entityType === "catalogue_item" ? <a href={`/settings/price-list/${r.entityId}`}>{LABEL[r.action] ?? r.action}</a>
                    : LABEL[r.action] ?? r.action}
                </td>
                <td data-label="Note"><span className="clamp">{r.reason ?? ""}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
