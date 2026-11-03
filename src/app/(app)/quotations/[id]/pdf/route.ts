/**
 * The quotation PDF. ?inline=1 opens it in the browser (Preview); otherwise it downloads.
 * Drafts are watermarked "DRAFT" and cancelled quotations "CANCELLED". Every download is logged.
 */
import { getSessionUser } from "@/auth/service";
import { isClientReady, loadQuote, logPdfDownload, userNames } from "@/quotations/service";
import { renderQuotationPdf } from "@/quotations/pdf";
import { loadCompany } from "@/company/service";
import { db, SESSION_COOKIE } from "@/web/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const token = req.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  const user = await getSessionUser(db(), token);
  if (!user) return new Response(null, { status: 303, headers: { Location: "/login" } });

  const params = new URL(req.url).searchParams;
  const v = params.get("v");
  const bundle = await loadQuote(db(), user, id, v && /^\d+$/.test(v) ? Number(v) : undefined);
  if (!bundle) return new Response("Not found", { status: 404 });

  const names = await userNames(db(), [bundle.quotation.ownerId]);
  const pdf = await renderQuotationPdf(bundle, { company: await loadCompany(db()), preparedByName: names[bundle.quotation.ownerId] ?? null });
  const clientReady = isClientReady(bundle.quotation, bundle.version);
  await logPdfDownload(db(), user, id, bundle.version.version, clientReady ? "client" : "draft_preview");

  const safeClient = bundle.quotation.clientCompany.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const rev = bundle.version.version > 1 ? `-rev${bundle.version.version}` : "";
  const suffix = clientReady ? "" : bundle.quotation.status === "cancelled" ? "-CANCELLED" : "-DRAFT";
  const filename = `${bundle.quotation.number}${rev}-${safeClient || "Quotation"}${suffix}.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${params.get("inline") === "1" ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
