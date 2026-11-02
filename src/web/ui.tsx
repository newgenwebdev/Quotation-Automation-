import type { ReactNode } from "react";
import { formatSen } from "@/pricing/engine";

export type Search = Promise<Record<string, string | string[] | undefined>>;

export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function Messages({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const ok = one(sp.ok);
  const error = one(sp.error);
  return (
    <>
      {ok && <div className="msg ok" role="status">{ok}</div>}
      {error && <div className="msg error" role="alert">{error}</div>}
    </>
  );
}

export function Status({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function Money({ sen, currency = "MYR" }: { sen: number | null; currency?: string }) {
  return <>{sen === null ? "—" : formatSen(sen, currency)}</>;
}

export function List({ items, empty = "—" }: { items: string[]; empty?: ReactNode }) {
  if (items.length === 0) return <span className="muted">{empty}</span>;
  return <ul className="plain">{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}

export function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : d;
  return dt.toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuala_Lumpur" });
}

export function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-MY", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" });
}
