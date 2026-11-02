/**
 * PRICE CHECKER — a hands-on way to try the pricing engine.
 * Pick approved services and quantities; the engine shows exactly what it would charge,
 * or why it refuses. Nothing is saved. (Phase 4 will turn this into real quotations.)
 */
import { asc, eq } from "drizzle-orm";
import { catalogueItems } from "@/db/schema";
import { can } from "@/auth/permissions";
import { priceQuotation } from "@/pricing/service";
import type { PricingResult } from "@/pricing/engine";
import { db, requireUser, ringgitToSen } from "@/web/server";
import { Money, one, type Search } from "@/web/ui";
import { describePrice } from "@/web/catalogue-form";

const ROWS = 5;
const STATUS_TEXT: Record<PricingResult["status"], string> = {
  priced: "Priced. Ready for finance approval.",
  needs_technical_review: "Priced, but Technical must review the scope first.",
  needs_estimate: "Not final. Some items need a technical estimate.",
  blocked: "Can't be priced. Fix the problems below.",
};
const CLASS_TEXT = { A_standard: "A · Standard package", B_customisable: "B · Customisable project", C_custom: "C · Custom solution" };

export default async function PriceCheckPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("pricing.calculate");
  const sp = await searchParams;
  const approved = await db().select().from(catalogueItems).where(eq(catalogueItems.status, "approved")).orderBy(asc(catalogueItems.code));

  const lines = Array.from({ length: ROWS }, (_, i) => ({ code: one(sp[`code${i}`]) ?? "", qty: one(sp[`qty${i}`]) ?? "1" }));
  const custom = (one(sp.custom) ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const discountPct = one(sp.discount) ?? "";
  const discountReason = one(sp.reason) ?? "";
  const submitted = one(sp.go) === "1";

  let result: PricingResult | null = null;
  let inputError: string | null = null;
  if (submitted) {
    try {
      const picked = lines.filter((l) => l.code);
      const discount = discountPct
        ? { type: "percent" as const, value: Math.round(ringgitToSen(discountPct, "Discount")), reason: discountReason }
        : undefined;
      result = await priceQuotation(db(), user, {
        currency: "MYR",
        asOf: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }),
        lines: picked.map((l) => ({ catalogueCode: l.code, quantity: Number(l.qty) })),
        customItems: custom.map((description) => ({ description })),
        discount,
      });
    } catch (e) {
      inputError = (e as Error).message;
    }
  }

  return (
    <>
      <h1>Price checker</h1>
      <p className="sub">Try combinations of approved services and see exactly what the pricing engine would charge. Nothing is saved.</p>

      {approved.length === 0 && <div className="msg warn">There are no approved prices yet, so everything will be refused.</div>}

      <form method="get" className="panel">
        <input type="hidden" name="go" value="1" />
        {lines.map((l, i) => (
          <div className="grid" key={i}>
            <div>
              <label htmlFor={`code${i}`}>Service {i + 1}</label>
              <select id={`code${i}`} name={`code${i}`} defaultValue={l.code}>
                <option value="">—</option>
                {approved.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name} · {describePrice(a)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`qty${i}`}>Quantity</label>
              <input id={`qty${i}`} name={`qty${i}`} inputMode="numeric" defaultValue={l.qty} />
            </div>
          </div>
        ))}
        <label htmlFor="custom">Anything with no approved price <span className="hint">one per line, e.g. "Integrate with SAP"</span></label>
        <textarea id="custom" name="custom" defaultValue={custom.join("\n")} />
        <div className="grid">
          <div>
            <label htmlFor="discount">Discount % <span className="hint">{can(user, "pricing.applyDiscount") ? "optional" : "Finance/Admin only"}</span></label>
            <input id="discount" name="discount" inputMode="decimal" defaultValue={discountPct} />
          </div>
          <div>
            <label htmlFor="reason">Discount reason</label>
            <input id="reason" name="reason" defaultValue={discountReason} />
          </div>
        </div>
        <p><button type="submit">Calculate</button></p>
      </form>

      {inputError && <div className="msg error">{inputError}</div>}
      {result && (
        <div className="panel">
          <div className={`msg ${result.status === "priced" ? "ok" : result.status === "blocked" ? "error" : "warn"}`}>
            <strong>{STATUS_TEXT[result.status]}</strong> Project type: {CLASS_TEXT[result.projectClass]}.
          </div>
          {result.lines.length > 0 && (
            <table>
              <thead><tr><th>Service</th><th>Qty</th><th>How it's calculated</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.catalogueCode}><td>{l.name} <span className="muted">v{l.catalogueVersion}</span></td><td>{l.quantity}</td><td>{l.calculation}</td><td className="num"><Money sen={l.lineTotalSen} /></td></tr>
                ))}
                <tr><td colSpan={3}>Subtotal</td><td className="num"><Money sen={result.subtotalSen} /></td></tr>
                {result.discountSen > 0 && <tr><td colSpan={3}>Discount</td><td className="num">−<Money sen={result.discountSen} /></td></tr>}
                {result.tax && <tr><td colSpan={3}>{result.tax.label} {result.tax.rateBp / 100}%</td><td className="num"><Money sen={result.tax.amountSen} /></td></tr>}
                <tr><td colSpan={3}><strong>{result.isFinalPrice ? "Total" : "Total of approved items only (not final)"}</strong></td><td className="num"><strong><Money sen={result.totalSen} /></strong></td></tr>
              </tbody>
            </table>
          )}
          {result.issues.length > 0 && (
            <>
              <h2>Notes</h2>
              <ul className="plain">{result.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
