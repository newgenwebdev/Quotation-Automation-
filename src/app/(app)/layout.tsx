import type { ReactNode } from "react";
import { requireUser } from "@/web/server";
import { Icon } from "@/web/ui";
import { NavLink } from "@/web/nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <a className="logo" href="/quotations">
          <img src="/brand/newgen-logo.png" alt="NewGen" width={109} height={26} />
          <span>Quotations · Quinn</span>
        </a>
        <NavLink href="/quotations" className="navlink"><Icon name="quotes" /><span className="lbl">Quotations</span></NavLink>
        <NavLink href="/settings" className="navlink"><Icon name="settings" /><span className="lbl">Settings</span></NavLink>
        <div className="me">
          <div>
            <div className="name">{user.name}</div>
            <div className="muted small">{user.email}</div>
          </div>
          <form method="post" action="/api/auth/logout">
            <button type="submit" className="ghost" title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
          </form>
        </div>
      </nav>
      <main id="main">{children}</main>
    </div>
  );
}
