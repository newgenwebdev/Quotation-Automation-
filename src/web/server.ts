/**
 * Helpers shared by pages and form handlers: database connection, current user,
 * permission checks, safe redirects and form parsing.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDb, type DB } from "@/db/client";
import { getSessionUser } from "@/auth/service";
import { can, type Permission, PermissionError } from "@/auth/permissions";
import type { User } from "@/db/schema";

export const SESSION_COOKIE = "ngo_session";

const g = globalThis as unknown as { __db?: DB };
export function db(): DB {
  if (!g.__db) g.__db = createDb().db;
  return g.__db;
}

/** For pages: returns the logged-in user or sends them to /login. */
export async function requireUser(permission?: Permission): Promise<User> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = await getSessionUser(db(), token);
  if (!user) redirect("/login");
  // (Everyone is an Admin, so this only triggers for an account changed by hand in the database.)
  if (permission && !can(user, permission)) redirect("/no-access");
  return user;
}

export async function optionalUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionUser(db(), token);
}

// ---------- Form handlers (route handlers) ----------

/** 303 redirect with a relative Location, so it works behind Dokploy's proxy. */
export function back(path: string, msg?: { ok?: string; error?: string }): Response {
  const qs = new URLSearchParams();
  if (msg?.ok) qs.set("ok", msg.ok);
  if (msg?.error) qs.set("error", msg.error);
  const sep = path.includes("?") ? "&" : "?";
  return new Response(null, { status: 303, headers: { Location: qs.size ? `${path}${sep}${qs}` : path } });
}

/**
 * Blocks cross-site form posts (CSRF): the form must come from our own site.
 * Session cookies are also SameSite=Lax, so this is a second layer.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}

export function isHttps(req: Request): boolean {
  return (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
}

/** Wraps a form handler: checks origin, login and permission, and turns errors into friendly messages. */
export function formHandler(
  opts: { permission?: Permission; errorPath: string | ((form: FormData) => string) },
  fn: (args: { user: User; form: FormData; req: Request }) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    const form = await req.formData();
    const errorPath = typeof opts.errorPath === "function" ? opts.errorPath(form) : opts.errorPath;
    if (!sameOrigin(req)) return new Response("Forbidden", { status: 403 });
    const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
    const user = await getSessionUser(db(), token);
    if (!user) return back("/login");
    if (opts.permission && !can(user, opts.permission)) return back(errorPath, { error: "You don't have permission to do that." });
    try {
      return await fn({ user, form, req });
    } catch (e) {
      return back(errorPath, { error: friendly(e) });
    }
  };
}

export function friendly(e: unknown): string {
  if (e instanceof PermissionError) return "You don't have permission to do that.";
  const err = e as { issues?: { message: string }[]; message?: string; code?: string };
  if (Array.isArray(err.issues)) return err.issues.map((i) => i.message).join(" · ");
  if (err.code && err.message && !String(err.message).startsWith("Failed query")) return err.message;
  console.error(e);
  return "Something went wrong. Nothing was saved.";
}

// ---------- Form parsing ----------

export function str(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}
export function optStr(form: FormData, key: string): string | null {
  const v = str(form, key);
  return v === "" ? null : v;
}
export function optInt(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === "") return null;
  if (!/^\d+$/.test(v)) throw Object.assign(new Error(`"${key}" must be a whole number.`), { code: "BAD_INPUT" });
  return Number(v);
}
export function lines(form: FormData, key: string): string[] {
  return str(form, key).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
/** "5,899.50" → 589950 sen. Exact: no floating-point maths. */
export function ringgitToSen(input: string, field = "Price"): number {
  const v = input.replace(/[,\s]/g, "").replace(/^RM/i, "");
  const m = v.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw Object.assign(new Error(`${field} must be an amount like 5899 or 5899.50`), { code: "BAD_INPUT" });
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}
export function optRinggitToSen(form: FormData, key: string, field: string): number | null {
  const v = str(form, key);
  return v === "" ? null : ringgitToSen(v, field);
}
export function senToRinggitInput(sen: number | null): string {
  if (sen === null) return "";
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`;
}
