"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** A sidebar / sub-navigation link that marks itself as the current page. */
export function NavLink({ href, className, children, exact }: { href: string; className?: string; children: ReactNode; exact?: boolean }) {
  const path = usePathname();
  const current = exact ? path === href : path === href || path.startsWith(href + "/");
  return <a href={href} className={className} aria-current={current ? "page" : undefined}>{children}</a>;
}
