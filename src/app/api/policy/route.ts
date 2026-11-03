import { savePolicy } from "@/catalogue/service";
import { back, db, formHandler, lines, optInt, optStr, str } from "@/web/server";

function percentToBp(v: string, field: string): number {
  const m = v.replace("%", "").trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) throw Object.assign(new Error(`${field} must be a percentage like 50 or 8.5`), { code: "BAD_INPUT" });
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export const POST = formHandler({ permission: "policy.manage", errorPath: "/settings/payment-terms" }, async ({ user, form }) => {
  const paymentMilestones = lines(form, "milestones").map((line) => {
    const [label, pct] = line.split("|").map((s) => s.trim());
    if (!label || !pct) throw Object.assign(new Error(`Write each payment as "Name | percent" (problem: "${line}")`), { code: "BAD_INPUT" });
    return { label, percentBp: percentToBp(pct, `Payment "${label}"`) };
  });
  const taxEnabled = form.get("taxEnabled") === "on";
  const row = await savePolicy(db(), user, {
    currency: "MYR",
    paymentMilestones,
    quoteValidityDays: optInt(form, "quoteValidityDays") as number,
    taxEnabled,
    taxLabel: taxEnabled ? optStr(form, "taxLabel") : null,
    taxRateBp: taxEnabled && str(form, "taxRate") ? percentToBp(str(form, "taxRate"), "Tax rate") : null,
    termsText: null,
    validFrom: str(form, "validFrom") || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }),
  });
  return back("/settings/payment-terms", { ok: `Payment terms saved (version ${row.version}). New quotations use them from now on.` });
});
