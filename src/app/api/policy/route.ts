import { createPolicyDraft } from "@/catalogue/service";
import { back, db, formHandler, lines, optInt, optStr, str } from "@/web/server";

function percentToBp(v: string, field: string): number {
  const m = v.replace("%", "").trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) throw Object.assign(new Error(`${field} must be a percentage like 50 or 8.5`), { code: "BAD_INPUT" });
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

export const POST = formHandler({ permission: "policy.draft", errorPath: "/policy" }, async ({ user, form }) => {
  const paymentMilestones = lines(form, "milestones").map((line) => {
    const [label, pct] = line.split("|").map((s) => s.trim());
    if (!label || !pct) throw Object.assign(new Error(`Write each milestone as "Name | percent" (problem: "${line}")`), { code: "BAD_INPUT" });
    return { label, percentBp: percentToBp(pct, `Milestone "${label}"`) };
  });
  const total = paymentMilestones.reduce((s, m) => s + m.percentBp, 0);
  if (total !== 10000) {
    throw Object.assign(new Error(`Milestones add up to ${total / 100}%. They must add up to exactly 100%.`), { code: "BAD_INPUT" });
  }
  const taxEnabled = form.get("taxEnabled") === "on";
  const row = await createPolicyDraft(db(), user, {
    currency: "MYR",
    paymentMilestones,
    quoteValidityDays: optInt(form, "quoteValidityDays"),
    taxEnabled,
    taxLabel: taxEnabled ? optStr(form, "taxLabel") : null,
    taxRateBp: taxEnabled && str(form, "taxRate") ? percentToBp(str(form, "taxRate"), "Tax rate") : null,
    termsText: optStr(form, "termsText"),
    validFrom: str(form, "validFrom"),
  });
  return back("/policy", { ok: `Draft v${row.version} saved. Another Finance or Admin person can now approve it.` });
});
