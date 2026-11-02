/**
 * Downloads the quotation PDF.
 * Approved version → the real client PDF. Anything else → a preview stamped "DRAFT – NOT FOR CLIENT".
 * Only people who can see the quotation can download it, and every download is logged.
 */
import { inArray } from "drizzle-orm";
import { users } from "@/db/schema";
import { getSessionUser } from "@/auth/service";
import { loadQuote, logPdfDownload } from "@/quotations/service";
import { isClientReady, renderQuotationPdf } from "@/quotations/pdf";
import { db, SESSION_COOKIE } from "@/web/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  const user = await getSessionUser(db(), token);
  if (!user) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const v = new URL(req.url).searchParams.get("v");
  const bundle = await loadQuote(db(), user, id, v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (!bundle) return new Response("Not found", { status: 404 });

  const ids = [bundle.version.decidedBy, bundle.quotation.ownerId].filter((x): x is string => !!x);
  const names = Object.fromEntries((await db().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  const pdf = await renderQuotationPdf(bundle, {
    approverName: bundle.version.decidedBy ? names[bundle.version.decidedBy] : null,
    preparedByName: names[bundle.quotation.ownerId],
  });
  const clientReady = isClientReady(bundle);
  await logPdfDownload(db(), user, id, bundle.version.version, clientReady ? "client" : "draft_preview");

  const safeClient = bundle.quotation.clientCompany.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const filename = `${bundle.quotation.number}-v${bundle.version.version}-${safeClient}${clientReady ? "" : "-DRAFT"}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${clientReady ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
