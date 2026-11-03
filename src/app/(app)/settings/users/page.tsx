import { cookies, headers } from "next/headers";
import { asc } from "drizzle-orm";
import { users } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";
import { SETUP_FLASH_COOKIE } from "@/web/setup-flash";

export default async function UsersPage({ searchParams }: { searchParams: Search }) {
  const me = await requireUser("users.manage");
  const sp = await searchParams;
  const list = await db().select().from(users).orderBy(asc(users.name));

  // A just-created setup link is passed once via a short-lived cookie, never in the URL.
  const flash = (await cookies()).get(SETUP_FLASH_COOKIE)?.value;
  let link: { name: string; url: string } | null = null;
  if (flash) {
    const [name, token] = decodeURIComponent(flash).split("\n");
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (name && token) link = { name, url: `${proto}://${host}/setup/${token}` };
  }

  return (
    <>
      <Messages sp={sp} />
      {link && (
        <div className="msg warn" role="status">
          <strong>Setup link for {link.name}</strong> (shown once, works once, expires in 72 hours). Send it to them privately, e.g. by WhatsApp. They&apos;ll choose their own password.
          <p className="mono" style={{ margin: "8px 0 0", wordBreak: "break-all" }}>{link.url}</p>
        </div>
      )}
      <div className="card">
        <h2>Users</h2>
        <p className="muted">Everyone here is an Admin: they can create, edit, finalise and export quotations and change Settings. Each quotation records who created it.</p>
        <div className="table-wrap" style={{ boxShadow: "none" }}>
          <table className="stack">
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td className="lead"><strong>{u.name}</strong>{u.id === me.id && <span className="muted"> (you)</span>}</td>
                  <td data-label="Email">{u.email}</td>
                  <td data-label="Status">{!u.active ? <span className="badge cancelled">Deactivated</span> : u.passwordHash ? <span className="badge active">Active</span> : <span className="badge draft">Waiting for setup</span>}</td>
                  <td data-label="Last sign-in" className="nowrap">{fmtDateTime(u.lastLoginAt)}</td>
                  <td data-label="Actions">
                    <div className="actions" style={{ justifyContent: "flex-end" }}>
                      {u.active && (
                        <form method="post" action={`/api/users/${u.id}/link`}>
                          <button type="submit" className="secondary sm">{u.passwordHash ? "Reset password link" : "New setup link"}</button>
                        </form>
                      )}
                      {u.id !== me.id && (
                        <form method="post" action={`/api/users/${u.id}/${u.active ? "deactivate" : "reactivate"}`}>
                          <button type="submit" className={`sm ${u.active ? "danger" : "secondary"}`}>{u.active ? "Deactivate" : "Reactivate"}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form method="post" action="/api/users" className="card">
        <h2>Add a person</h2>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" required autoComplete="off" /></div>
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="off" /></div>
        </div>
        <button type="submit">Add and create setup link</button>
      </form>
    </>
  );
}
