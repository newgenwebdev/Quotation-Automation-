import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { termsTemplates } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, type Search } from "@/web/ui";

export default async function EditTermsTemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  await requireUser("terms.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [t] = await db().select().from(termsTemplates).where(eq(termsTemplates.id, id));
  if (!t) notFound();
  return (
    <>
      <a className="back" href="/settings/terms">← T&amp;C templates</a>
      <Messages sp={sp} />
      <form method="post" action={`/api/terms/${t.id}`} className="card">
        <h2>{t.name}</h2>
        <p className="muted">Changes apply to quotations created from now on. Existing quotations keep their own wording.</p>
        <div className="field"><label htmlFor="name">Template name</label><input id="name" name="name" required maxLength={100} defaultValue={t.name} /></div>
        <div className="field"><label htmlFor="body">Terms &amp; conditions</label><textarea id="body" name="body" rows={16} required defaultValue={t.body} /></div>
        <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" name="isDefault" defaultChecked={t.isDefault} /> Default for new quotations</label>
        <label className="check" style={{ marginBottom: 14 }}><input type="checkbox" name="active" defaultChecked={t.active} /> Available to choose <span className="hint">(untick to retire it)</span></label>
        <div className="field"><label htmlFor="reason">Reason for the change <span className="hint">· optional, kept in the activity log</span></label><input id="reason" name="reason" maxLength={300} /></div>
        <button type="submit">Save changes</button>
      </form>
    </>
  );
}
