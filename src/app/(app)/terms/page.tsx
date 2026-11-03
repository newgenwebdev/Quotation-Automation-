import { inArray } from "drizzle-orm";
import { users } from "@/db/schema";
import { listTemplates } from "@/terms/service";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";

export default async function TermsTemplatesPage({ searchParams }: { searchParams: Search }) {
  await requireUser("terms.manage");
  const sp = await searchParams;
  const list = await listTemplates(db());
  const ids = [...new Set(list.flatMap((t) => [t.createdBy, t.updatedBy]).filter((x): x is string => !!x))];
  const people = ids.length
    ? Object.fromEntries((await db().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]))
    : {};

  return (
    <>
      <h1>T&amp;C templates</h1>
      <p className="sub">
        Standard terms &amp; conditions that Sales start from. Each quotation keeps its own copy, so Sales can adjust
        the terms for a particular client, and changing a template never alters quotations already made.
      </p>
      <Messages sp={sp} />

      {list.length === 0 ? (
        <div className="panel"><strong>No templates yet.</strong> <span className="muted">Add your standard terms below and tick "default" so every new quotation starts with them.</span></div>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Use</th><th>Last changed</th></tr></thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td><a href={`/terms/${t.id}`}>{t.name}</a></td>
                <td>{!t.active ? <span className="badge retired">inactive</span> : t.isDefault ? <span className="badge approved">default for new quotations</span> : <span className="muted">available</span>}</td>
                <td>{fmtDateTime(t.updatedAt)} <span className="muted">by {people[t.updatedBy ?? t.createdBy] ?? "—"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Add a template</h2>
      <form method="post" action="/api/terms" className="panel">
        <label htmlFor="name">Template name <span className="hint">e.g. "Website projects", "Government / GLC", "Monthly retainer"</span></label>
        <input id="name" name="name" required maxLength={100} />
        <label htmlFor="body">Terms &amp; conditions <span className="hint">printed on the quotation exactly as written</span></label>
        <textarea id="body" name="body" rows={14} required placeholder={"1. …\n2. …"} />
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="isDefault" /> Use as the default for new quotations
        </label>
        <p><button type="submit">Save template</button></p>
      </form>
    </>
  );
}
