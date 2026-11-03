import type { ReactNode } from "react";
import { NavLink } from "@/web/nav";

export const metadata = { title: "Settings · NewGen" };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">What every quotation uses automatically: company details, prices, payment terms and T&amp;C.</p>
        </div>
      </div>
      <div className="settings">
        <nav className="subnav" aria-label="Settings">
          <NavLink href="/settings/company">Company profile</NavLink>
          <NavLink href="/settings/price-list">Price list</NavLink>
          <NavLink href="/settings/payment-terms">Payment terms</NavLink>
          <NavLink href="/settings/terms">T&amp;C templates</NavLink>
          <NavLink href="/settings/users">Users</NavLink>
          <span className="sep" aria-hidden="true" />
          <NavLink href="/settings/activity">Activity log</NavLink>
        </nav>
        <div>{children}</div>
      </div>
    </>
  );
}
