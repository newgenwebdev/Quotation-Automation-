import { desc } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { fmtDateTime } from "@/web/ui";

export default async function AuditPage() {
  await requireUser("audit.read");
  const rows = await db().select({
    id: auditLog.id, at: auditLog.at, actorLabel: auditLog.actorLabel, action: auditLog.action,
    entityType: auditLog.entityType, entityId: auditLog.entityId, reason: auditLog.reason,
  }).from(auditLog).orderBy(desc(auditLog.id)).limit(200);

  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">Every price, payment-term and user change. Entries can't be edited or deleted, even directly in the database. Showing the latest 200.</p>
      <table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Note</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtDateTime(r.at)}</td>
              <td>{r.actorLabel}</td>
              <td className="mono">{r.action}</td>
              <td>{r.entityType === "catalogue_item" ? <a href={`/catalogue/${r.entityId}`}>price</a> : r.entityType.replace("_", " ")}</td>
              <td>{r.reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
