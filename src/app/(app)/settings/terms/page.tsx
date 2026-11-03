import { listTemplates } from "@/terms/service";
import { userNames } from "@/quotations/service";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";

export default async function TermsTemplatesPage({ searchParams }: { searchParams: Search }) {
  await requireUser("terms.manage");
  const sp = await searchParams;
  const list = await listTemplates(db());
  const names = await userNames(db(), list.flatMap((t) => [t.createdBy, t.updatedBy]));

  return (
    <>
      <Messages sp={sp} />
      <div className="card">
        <h2>T&amp;C templates</h2>
        <p className="muted">The <strong>default</strong> template is added to every new quotation automatically. Each quotation keeps its own copy, so it can be adjusted for one client, and editing a template never changes quotations already made.</p>
        {list.length === 0 ? (
          <div className="msg warn" style={{ marginBottom: 0 }}>No templates yet, so new quotations start without terms &amp; conditions. Add your standard terms below and tick “default”.</div>
        ) : (
          <div className="table-wrap" style={{ boxShadow: "none" }}>
            <table className="stack">
              <thead><tr><th>Name</th><th>Use</th><th>Last changed</th></tr></thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td className="lead"><a className="title" href={`/settings/terms/${t.id}`}>{t.name}</a></td>
                    <td data-label="Use">{!t.active ? <span className="badge retired">Inactive</span> : t.isDefault ? <span className="badge active">Default for new quotations</span> : <span className="muted">Available</span>}</td>
                    <td data-label="Last changed" className="nowrap">{fmtDateTime(t.updatedAt)} <span className="muted">· {names[t.updatedBy ?? t.createdBy] ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <form method="post" action="/api/terms" className="card">
        <h2>Add a template</h2>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="name">Template name <span className="hint">· e.g. Standard, Government / GLC, Monthly retainer</span></label>
          <input id="name" name="name" required maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor="body">Terms &amp; conditions <span className="hint">· printed exactly as written</span></label>
          <textarea id="body" name="body" rows={12} required placeholder={"1. …\n2. …"} />
        </div>
        <label className="check" style={{ marginBottom: 14 }}><input type="checkbox" name="isDefault" defaultChecked={list.length === 0} /> Default for new quotations</label>
        <button type="submit">Save template</button>
      </form>
    </>
  );
}
