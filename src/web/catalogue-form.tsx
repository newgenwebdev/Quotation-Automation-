import type { CatalogueItem } from "@/db/schema";
import type { CatalogueInput } from "@/catalogue/service";
import { formatRM, quantityText } from "@/quotations/calc";
import { lines, optInt, optRinggitToSen, optStr, ringgitToSen, senToRinggitInput, str } from "./server";

export const CATEGORIES = [
  ["website", "Website"], ["landing_page", "Landing page"], ["ecommerce", "E-commerce"],
  ["mobile_app", "Mobile app"], ["custom_software", "Custom software"], ["ai_automation", "AI automation"],
  ["seo", "SEO"], ["hosting", "Hosting"], ["maintenance", "Maintenance"], ["other", "Other"],
] as const;

/** Plain-English description of how an item is priced. */
export function describePrice(i: Pick<CatalogueItem, "pricingModel" | "priceSen" | "currency" | "unitLabel" | "includedUnits" | "extraUnitPriceSen" | "minQuantity" | "maxQuantity">): string {
  const unit = i.unitLabel ?? "unit";
  const limit = i.maxQuantity !== null && i.pricingModel !== "fixed" ? ` (max ${i.maxQuantity})` : "";
  switch (i.pricingModel) {
    case "fixed": return `${formatRM(i.priceSen, i.currency)} fixed`;
    case "per_unit": return `${formatRM(i.priceSen, i.currency)} per ${unit}${limit}`;
    case "base_plus_units":
      return `${formatRM(i.priceSen, i.currency)} for up to ${quantityText(i.includedUnits ?? 0, unit)}, then ${formatRM(i.extraUnitPriceSen ?? 0, i.currency)} per extra ${unit}${limit}`;
  }
}

/** Turn a submitted form into price-list input. Validation happens in the service. */
export function catalogueInputFromForm(form: FormData): CatalogueInput {
  const model = str(form, "pricingModel") as CatalogueInput["pricingModel"];
  const isFixed = model === "fixed";
  return {
    code: str(form, "code").toUpperCase(),
    name: str(form, "name"),
    category: str(form, "category") as CatalogueInput["category"],
    kind: "package",
    currency: "MYR",
    pricingModel: model,
    priceSen: ringgitToSen(str(form, "price"), "Price"),
    includedUnits: model === "base_plus_units" ? optInt(form, "includedUnits") : null,
    extraUnitPriceSen: model === "base_plus_units" ? optRinggitToSen(form, "extraUnitPrice", "Extra unit price") : null,
    unitLabel: isFixed ? null : optStr(form, "unitLabel"),
    minQuantity: isFixed ? 1 : optInt(form, "minQuantity") ?? 1,
    maxQuantity: isFixed ? 1 : optInt(form, "maxQuantity"),
    inclusions: lines(form, "inclusions"),
    exclusions: lines(form, "exclusions"),
    revisionLimit: optInt(form, "revisionLimit"),
    validFrom: str(form, "validFrom"),
    validTo: optStr(form, "validTo"),
    notes: optStr(form, "notes"),
  };
}

export function CatalogueForm({ action, item, lockCode, submitLabel }: {
  action: string; item?: Partial<CatalogueItem>; lockCode?: boolean; submitLabel: string;
}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  return (
    <form method="post" action={action} className="card">
      <div className="grid-3">
        <div className="field">
          <label htmlFor="code">Code <span className="hint">· e.g. WEB-CORP</span></label>
          <input id="code" name="code" defaultValue={item?.code ?? ""} readOnly={lockCode} required pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,40}" title="Letters, digits and dashes" />
        </div>
        <div className="field">
          <label htmlFor="name">Service name</label>
          <input id="name" name="name" defaultValue={item?.name ?? ""} required />
        </div>
        <div className="field">
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue={item?.category ?? "website"}>
            {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>

      <h3>Pricing</h3>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="pricingModel">How is it priced?</label>
          <select id="pricingModel" name="pricingModel" defaultValue={item?.pricingModel ?? "fixed"}>
            <option value="fixed">Fixed price (one package)</option>
            <option value="per_unit">Price per unit (page, day, month…)</option>
            <option value="base_plus_units">Package + extra units</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="price">Price (RM) <span className="hint">· package or per-unit price</span></label>
          <input id="price" name="price" inputMode="decimal" defaultValue={senToRinggitInput(item?.priceSen ?? null)} required />
        </div>
        <div className="field">
          <label htmlFor="unitLabel">Unit <span className="hint">· per-unit and package + units</span></label>
          <input id="unitLabel" name="unitLabel" placeholder="page, day, month" maxLength={20} defaultValue={item?.unitLabel ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="includedUnits">Units included in the package <span className="hint">· package + units</span></label>
          <input id="includedUnits" name="includedUnits" inputMode="numeric" defaultValue={item?.includedUnits ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="extraUnitPrice">Price per extra unit (RM) <span className="hint">· package + units</span></label>
          <input id="extraUnitPrice" name="extraUnitPrice" inputMode="decimal" defaultValue={senToRinggitInput(item?.extraUnitPriceSen ?? null)} />
        </div>
        <div className="field">
          <label htmlFor="revisionLimit">Revision rounds included <span className="hint">· optional</span></label>
          <input id="revisionLimit" name="revisionLimit" inputMode="numeric" defaultValue={item?.revisionLimit ?? ""} />
        </div>
        <div className="field">
          <label htmlFor="minQuantity">Minimum quantity</label>
          <input id="minQuantity" name="minQuantity" inputMode="numeric" defaultValue={item?.minQuantity ?? 1} />
        </div>
        <div className="field">
          <label htmlFor="maxQuantity">Maximum quantity <span className="hint">· blank = no limit</span></label>
          <input id="maxQuantity" name="maxQuantity" inputMode="numeric" defaultValue={item?.maxQuantity ?? ""} />
        </div>
      </div>

      <h3>What&apos;s included</h3>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="inclusions">Included <span className="hint">· one per line</span></label>
          <textarea id="inclusions" name="inclusions" defaultValue={(item?.inclusions ?? []).join("\n")} />
        </div>
        <div className="field">
          <label htmlFor="exclusions">Not included <span className="hint">· one per line</span></label>
          <textarea id="exclusions" name="exclusions" defaultValue={(item?.exclusions ?? []).join("\n")} />
        </div>
      </div>

      <h3>Validity</h3>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="validFrom">Valid from</label>
          <input id="validFrom" name="validFrom" type="date" defaultValue={item?.validFrom && item.validFrom > today ? item.validFrom : today} required />
        </div>
        <div className="field">
          <label htmlFor="validTo">Valid until <span className="hint">· blank = until changed</span></label>
          <input id="validTo" name="validTo" type="date" defaultValue={item?.validTo ?? ""} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="notes">Internal notes <span className="hint">· not shown to clients or Quinn</span></label>
        <textarea id="notes" name="notes" rows={2} defaultValue={item?.notes ?? ""} />
      </div>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
