/** Everything the quotation editor needs from the server besides the quotation itself. */
import type { DB } from "@/db/client";
import { activePriceList } from "@/catalogue/service";
import { listTemplates } from "@/terms/service";
import { newQuoteDefaults } from "@/quotations/service";
import { todayKL } from "@/quotations/calc";
import { describePrice } from "@/web/catalogue-form";

export async function editorContext(db: DB) {
  const today = todayKL();
  const [defaults, items, templates] = await Promise.all([newQuoteDefaults(db), activePriceList(db, today), listTemplates(db, { activeOnly: true })]);
  return {
    today,
    defaults,
    validityDays: defaults.validityDays,
    priceList: items.map((i) => ({
      id: i.id, code: i.code, version: i.version, name: i.name, category: i.category, pricingModel: i.pricingModel,
      priceSen: i.priceSen, includedUnits: i.includedUnits, extraUnitPriceSen: i.extraUnitPriceSen, unitLabel: i.unitLabel,
      minQuantity: i.minQuantity, maxQuantity: i.maxQuantity, priceText: describePrice(i),
    })),
    templates: templates.map((t) => ({ id: t.id, name: t.name, body: t.body, isDefault: t.isDefault })),
  };
}
