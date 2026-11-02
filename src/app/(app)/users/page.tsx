import { cookies, headers } from "next/headers";
import { asc } from "drizzle-orm";
import { users } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { Messages, fmtDateTime, type Search } from "@/web/ui";
import { SETUP_FLASH_COOKIE } from "@/web/setup-flash";

const ROLES = [["sales", "Sales"], ["technical", "Technical"], ["finance", "Finance"], ["admin", "Admin"]] as const;

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
      <h1>Users</h1>
      <p className="sub">Who can sign in, and what each person is allowed to do.</p>
      <Messages sp={sp} />

      {link && (
        <div className="msg warn" role="status">
          <strong>Setup link for {link.name}</strong> (shown once, works once, expires in 72 hours).<br />
          Send it to them privately, e.g. by WhatsApp. They'll choose their own password.
          <p className="mono" style={{ margin: "8px 0 0" }}>{link.url}</p>
        </div>
      )}

      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.name}{u.id === me.id && <span className="muted"> (you)</span>}</td>
              <td>{u.email}</td>
              <td>
                <form method="post" action={`/api/users/${u.id}/role`} className="row">
                  <select name="role" defaultValue={u.role} aria-label={`Role for ${u.name}`} style={{ width: "auto" }}>
                    {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button type="submit" className="secondary">Save</button>
                </form>
              </td>
              <td>{!u.active ? "Deactivated" : u.passwordHash ? "Active" : "Waiting for setup"}</td>
              <td>{fmtDateTime(u.lastLoginAt)}</td>
              <td>
                <div className="row">
                  {u.active && (
                    <form method="post" action={`/api/users/${u.id}/link`}>
                      <button type="submit" className="secondary">{u.passwordHash ? "Reset password link" : "New setup link"}</button>
                    </form>
                  )}
                  <form method="post" action={`/api/users/${u.id}/${u.active ? "deactivate" : "reactivate"}`}>
                    <button type="submit" className={u.active ? "danger" : "secondary"}>{u.active ? "Deactivate" : "Reactivate"}</button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add a person</h2>
      <form method="post" action="/api/users" className="panel">
        <div className="grid">
          <div><label htmlFor="name">Name</label><input id="name" name="name" required /></div>
          <div><label htmlFor="email">Email</label><input id="email" name="email" type="email" required /></div>
          <div>
            <label htmlFor="role">Role</label>
            <select id="role" name="role" defaultValue="sales">{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
        </div>
        <p className="muted">Sales: quote approved prices. Technical: review scope. Finance: manage and approve prices and terms. Admin: everything, including users.</p>
        <p><button type="submit">Add and create setup link</button></p>
      </form>
    </>
  );
}
