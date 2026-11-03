/**
 * Loads NewGen's INDICATIVE prices as drafts ("Not in use yet" in Settings → Price list).
 * Nothing here is used in quotations until someone opens each item, checks it and clicks
 * "Put into use".
 *
 * Inclusions, exclusions, page limits and revision counts are left EMPTY on purpose:
 * they are commercial terms NewGen must define, not something to guess.
 *
 * Run once on a fresh database:  npm run seed:drafts
 */
import { and, eq, max } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { catalogueItems, users } from "../src/db/schema";
import { CatalogueInput } from "../src/catalogue/service";

const NOTE = "Indicative price from founder (Oct 2026). Confirm inclusions, exclusions, limits and revisions before putting it into use.";
const from = "2026-11-01";

const drafts: CatalogueInput[] = [
  { code: "WEB-TEMPLATE", name: "Template Website", category: "website", kind: "package", pricingModel: "fixed", priceSen: 589_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "WEB-CUSTOM", name: "Custom Website", category: "website", kind: "package", pricingModel: "fixed", priceSen: 989_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "LANDING-PAGE", name: "Landing Page", category: "landing_page", kind: "package", pricingModel: "per_unit", priceSen: 200_000, unitLabel: "page", validFrom: from, notes: NOTE },
  { code: "ECOM-BASIC", name: "Basic E-commerce", category: "ecommerce", kind: "package", pricingModel: "fixed", priceSen: 889_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ECOM-PREMIUM", name: "Premium E-commerce", category: "ecommerce", kind: "package", pricingModel: "fixed", priceSen: 1_889_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ADD-CUSTOM-FEATURE", name: "Custom Feature", category: "custom_software", kind: "add_on", pricingModel: "per_unit", priceSen: 600_000, unitLabel: "feature", validFrom: from, notes: NOTE },
  { code: "SEO-STARTER", name: "SEO Package (Tier 1)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 900_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "SEO-GROWTH", name: "SEO Package (Tier 2)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 1_600_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "SEO-PREMIUM", name: "SEO Package (Tier 3)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 3_200_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ADD-HOSTING", name: "Hosting", category: "hosting", kind: "add_on", pricingModel: "per_unit", priceSen: 150_000, unitLabel: "year", validFrom: from, notes: NOTE },
  { code: "ADD-MAINTENANCE", name: "Maintenance & Support", category: "maintenance", kind: "add_on", pricingModel: "per_unit", priceSen: 129_900, unitLabel: "month", validFrom: from, notes: NOTE },
  // Not seeded on purpose: "Mobile app from RM55,000" and "Custom e-commerce RM20,000+".
  // "From" prices aren't fixed prices; those items are priced per quotation.
];

async function main() {
  const { db, pool } = createDb();
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@newgen.local";
  let [admin] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!admin) [admin] = await db.insert(users).values({ email: adminEmail, name: "NewGen Admin", role: "admin" }).returning();
  for (const d of drafts) {
    const input = CatalogueInput.parse(d);
    const [existing] = await db.select({ id: catalogueItems.id }).from(catalogueItems).where(and(eq(catalogueItems.code, input.code), eq(catalogueItems.status, "draft")));
    if (existing) { console.log(`skip   ${input.code} (draft already there)`); continue; }
    const [{ v }] = await db.select({ v: max(catalogueItems.version) }).from(catalogueItems).where(eq(catalogueItems.code, input.code));
    const [row] = await db.insert(catalogueItems).values({ ...input, version: (v ?? 0) + 1, status: "draft", createdBy: admin.id }).returning();
    console.log(`draft  ${row.code} v${row.version}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
