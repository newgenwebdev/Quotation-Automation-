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
      <p><a href="/terms">← T&amp;C templates</a></p>
      <h1>{t.name}</h1>
      <p className="sub">Changes apply to quotations that start from this template from now on. Existing quotations keep their own wording.</p>
      <Messages sp={sp} />
      <form method="post" action={`/api/terms/${t.id}`} className="panel">
        <label htmlFor="name">Template name</label>
        <input id="name" name="name" required maxLength={100} defaultValue={t.name} />
        <label htmlFor="body">Terms &amp; conditions</label>
        <textarea id="body" name="body" rows={16} required defaultValue={t.body} />
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="isDefault" defaultChecked={t.isDefault} /> Use as the default for new quotations
        </label>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" name="active" defaultChecked={t.active} /> Available to Sales <span className="hint">untick to retire this template</span>
        </label>
        <label htmlFor="reason">Reason for the change <span className="hint">optional, kept in the audit log</span></label>
        <input id="reason" name="reason" />
        <p><button type="submit">Save changes</button></p>
      </form>
    </>
  );
}
