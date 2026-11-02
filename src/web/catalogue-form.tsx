import type { CatalogueItem } from "@/db/schema";
import type { CatalogueDraftInput } from "@/catalogue/service";
import { formatSen } from "@/pricing/engine";
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
    case "fixed": return `${formatSen(i.priceSen, i.currency)} fixed`;
    case "per_unit": return `${formatSen(i.priceSen, i.currency)} per ${unit}${limit}`;
    case "base_plus_units":
      return `${formatSen(i.priceSen, i.currency)} for up to ${i.includedUnits} ${unit}s, then ${formatSen(i.extraUnitPriceSen ?? 0, i.currency)} per extra ${unit}${limit}`;
  }
}

/** Turn a submitted form into catalogue input. Validation happens in the service. */
export function catalogueInputFromForm(form: FormData): CatalogueDraftInput {
  const model = str(form, "pricingModel") as CatalogueDraftInput["pricingModel"];
  const isFixed = model === "fixed";
  return {
    code: str(form, "code").toUpperCase(),
    name: str(form, "name"),
    category: str(form, "category") as CatalogueDraftInput["category"],
    kind: str(form, "kind") as CatalogueDraftInput["kind"],
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
    technicalReviewConditions: lines(form, "technicalReviewConditions"),
    alwaysRequiresTechnicalReview: form.get("alwaysRequiresTechnicalReview") === "on",
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
    <form method="post" action={action} className="panel">
      <div className="grid">
        <div>
          <label htmlFor="code">Code <span className="hint">e.g. WEB-CUSTOM, DEV-DAY-RATE</span></label>
          <input id="code" name="code" defaultValue={item?.code ?? ""} readOnly={lockCode} required pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,40}" />
        </div>
        <div>
          <label htmlFor="name">Service name</label>
          <input id="name" name="name" defaultValue={item?.name ?? ""} required />
        </div>
        <div>
          <label htmlFor="category">Category</label>
          <select id="category" name="category" defaultValue={item?.category ?? "website"}>
            {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="kind">Type</label>
          <select id="kind" name="kind" defaultValue={item?.kind ?? "package"}>
            <option value="package">Package (sold on its own)</option>
            <option value="add_on">Add-on (only with a package)</option>
          </select>
        </div>
      </div>

      <h2>Pricing</h2>
      <div className="grid">
        <div>
          <label htmlFor="pricingModel">How is it priced?</label>
          <select id="pricingModel" name="pricingModel" defaultValue={item?.pricingModel ?? "fixed"}>
            <option value="fixed">Fixed price</option>
            <option value="per_unit">Price per unit (page, feature, day, month…)</option>
            <option value="base_plus_units">Base price + extra units</option>
          </select>
        </div>
        <div>
          <label htmlFor="price">Price (RM) <span className="hint">base or per-unit price</span></label>
          <input id="price" name="price" inputMode="decimal" defaultValue={senToRinggitInput(item?.priceSen ?? null)} required />
        </div>
        <div>
          <label htmlFor="unitLabel">Unit name <span className="hint">per-unit / base+units only</span></label>
          <input id="unitLabel" name="unitLabel" placeholder="page, feature, day, month" defaultValue={item?.unitLabel ?? ""} />
        </div>
        <div>
          <label htmlFor="includedUnits">Units included in base <span className="hint">base+units only</span></label>
          <input id="includedUnits" name="includedUnits" inputMode="numeric" defaultValue={item?.includedUnits ?? ""} />
        </div>
        <div>
          <label htmlFor="extraUnitPrice">Price per extra unit (RM) <span className="hint">base+units only</span></label>
          <input id="extraUnitPrice" name="extraUnitPrice" inputMode="decimal" defaultValue={senToRinggitInput(item?.extraUnitPriceSen ?? null)} />
        </div>
        <div>
          <label htmlFor="minQuantity">Minimum quantity</label>
          <input id="minQuantity" name="minQuantity" inputMode="numeric" defaultValue={item?.minQuantity ?? 1} />
        </div>
        <div>
          <label htmlFor="maxQuantity">Maximum quantity <span className="hint">blank = no limit</span></label>
          <input id="maxQuantity" name="maxQuantity" inputMode="numeric" defaultValue={item?.maxQuantity ?? ""} />
        </div>
        <div>
          <label htmlFor="revisionLimit">Revision rounds included <span className="hint">blank = not stated</span></label>
          <input id="revisionLimit" name="revisionLimit" inputMode="numeric" defaultValue={item?.revisionLimit ?? ""} />
        </div>
      </div>

      <h2>Scope</h2>
      <div className="grid">
        <div>
          <label htmlFor="inclusions">What's included <span className="hint">one per line</span></label>
          <textarea id="inclusions" name="inclusions" defaultValue={(item?.inclusions ?? []).join("\n")} />
        </div>
        <div>
          <label htmlFor="exclusions">What's NOT included <span className="hint">one per line</span></label>
          <textarea id="exclusions" name="exclusions" defaultValue={(item?.exclusions ?? []).join("\n")} />
        </div>
      </div>
      <label htmlFor="technicalReviewConditions">Send to Technical for review when… <span className="hint">one per line</span></label>
      <textarea id="technicalReviewConditions" name="technicalReviewConditions" defaultValue={(item?.technicalReviewConditions ?? []).join("\n")} />
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" name="alwaysRequiresTechnicalReview" defaultChecked={item?.alwaysRequiresTechnicalReview ?? false} />
        Always require technical review when this item is quoted
      </label>

      <h2>Validity</h2>
      <div className="grid">
        <div>
          <label htmlFor="validFrom">Valid from</label>
          <input id="validFrom" name="validFrom" type="date" defaultValue={item?.validFrom ?? today} required />
        </div>
        <div>
          <label htmlFor="validTo">Valid until <span className="hint">blank = until replaced</span></label>
          <input id="validTo" name="validTo" type="date" defaultValue={item?.validTo ?? ""} />
        </div>
      </div>
      <label htmlFor="notes">Internal notes</label>
      <textarea id="notes" name="notes" defaultValue={item?.notes ?? ""} />
      <p><button type="submit">{submitLabel}</button></p>
    </form>
  );
}
