/**
 * Saves the quotation editor (JSON). Creates the quotation on first save. With "finalise": true
 * it saves first (so nothing typed is lost) and then tries to finalise, returning what's missing
 * if it isn't ready.
 */
import { getSessionUser } from "@/auth/service";
import { can, PermissionError } from "@/auth/permissions";
import { QuoteError, finaliseQuotation, saveDraft } from "@/quotations/service";
import { db, sameOrigin, SESSION_COOKIE } from "@/web/server";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ ok: false, error: "Forbidden" }, 403);
  const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  const user = await getSessionUser(db(), token);
  if (!user) return json({ ok: false, error: "Please sign in again." }, 401);
  if (!can(user, "quotes.create")) return json({ ok: false, error: "You don't have permission to do that." }, 403);
  if (Number(req.headers.get("content-length") ?? 0) > 2_000_000) return json({ ok: false, error: "This quotation is too large to save." }, 413);

  let body: { id?: unknown; payload?: unknown; finalise?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "The request couldn't be read." }, 400); }
  const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : undefined;

  try {
    const { quotation, version } = await saveDraft(db(), user, body.payload as never, { quotationId: id });
    let finalised = false;
    let errors: string[] | undefined;
    let updatedAt = quotation.updatedAt;
    if (body.finalise === true) {
      try {
        await finaliseQuotation(db(), user, quotation.id);
        finalised = true;
        updatedAt = new Date();
      } catch (e) {
        if (e instanceof QuoteError && e.code === "NOT_READY") errors = e.details ?? [e.message];
        else if (e instanceof QuoteError || (e as { message?: string }).message?.match(/UNPRICED_LINES|NO_LINES/)) errors = [friendlyDb(e)];
        else throw e;
      }
    }
    return json({ ok: true, id: quotation.id, number: quotation.number, version: version.version, updatedAt: updatedAt.toISOString(), finalised, errors });
  } catch (e) {
    const issues = (e as { issues?: { message: string }[] }).issues;
    if (Array.isArray(issues)) return json({ ok: false, error: "Please fix the following:", issues: [...new Set(issues.map((i) => i.message))] }, 422);
    if (e instanceof PermissionError) return json({ ok: false, error: "You don't have permission to do that." }, 403);
    if (e instanceof QuoteError) return json({ ok: false, error: e.message, code: e.code }, e.code === "NOT_FOUND" ? 404 : 409);
    if ((e as { code?: string }).code === "TOO_LARGE") return json({ ok: false, error: (e as Error).message }, 422);
    console.error("[quotations/save]", e);
    return json({ ok: false, error: "Something went wrong. Nothing was saved. Please try again." }, 500);
  }
}

function friendlyDb(e: unknown): string {
  const m = (e as { message?: string }).message ?? "";
  if (m.includes("UNPRICED_LINES")) return "Price review required: every item needs a unit price before finalising.";
  if (m.includes("NO_LINES")) return "Add at least one pricing item.";
  return m;
}
