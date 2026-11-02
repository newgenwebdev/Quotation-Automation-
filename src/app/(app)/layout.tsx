import type { ReactNode } from "react";
import { requireUser } from "@/web/server";
import { can } from "@/auth/permissions";

export const dynamic = "force-dynamic";

const ROLE_LABEL = { sales: "Sales", technical: "Technical", finance: "Finance", admin: "Admin" } as const;

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">NewGen AI Office</div>
        <div className="who">{user.name} · {ROLE_LABEL[user.role]}</div>
        <a href="/catalogue">Price list</a>
        <a href="/price-check">Price checker</a>
        <a href="/policy">Payment terms</a>
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
