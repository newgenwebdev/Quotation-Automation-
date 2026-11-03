import type { ReactNode } from "react";
import { eq, sql } from "drizzle-orm";
import { quotations } from "@/db/schema";
import { db, requireUser } from "@/web/server";
import { can } from "@/auth/permissions";

export const dynamic = "force-dynamic";

const ROLE_LABEL = { sales: "Sales", technical: "Technical", finance: "Finance", admin: "Admin" } as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const approver = can(user, "quotes.approve");
  const waiting = approver
    ? (await db().select({ n: sql<number>`count(*)::int` }).from(quotations).where(eq(quotations.status, "pending_approval")))[0].n
    : 0;
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">NewGen AI Office</div>
        <div className="who">{user.name} · {ROLE_LABEL[user.role]}</div>
        <a href="/quotations">Quotations</a>
        {approver && <a href="/approvals">Approvals{waiting > 0 && <span className="count">{waiting}</span>}</a>}
        <a href="/catalogue">Price list</a>
        {can(user, "policy.draft") && <a href="/policy">Payment terms</a>}
        {can(user, "terms.manage") && <a href="/terms">T&amp;C templates</a>}
        {can(user, "audit.read") && <a href="/audit">Audit log</a>}
        {can(user, "users.manage") && <a href="/users">Users</a>}
        <form method="post" action="/api/auth/logout">
          <button type="submit" className="secondary">Sign out</button>
        </form>
      </nav>
      <main>{children}</main>
    </div>
  );
}
