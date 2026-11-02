/**
 * Loads NewGen's INDICATIVE prices as DRAFTS for finance to review.
 * Nothing here is approved, so none of it can be used in a quotation
 * until a Finance/Admin user reviews, completes and approves each item.
 *
 * Inclusions, exclusions, page limits and revision counts are left EMPTY on purpose:
 * they are commercial terms that finance must define, not something to guess.
 *
 * Run once on a fresh database:  npm run seed:drafts
 */
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import { createCatalogueDraft, createPolicyDraft, type CatalogueDraftInput } from "../src/catalogue/service";

const NOTE = "Indicative price from founder (Oct 2026). Finance: confirm inclusions, exclusions, limits and revisions before approving.";
const from = "2026-11-01";

const drafts: CatalogueDraftInput[] = [
  { code: "WEB-TEMPLATE", name: "Template Website", category: "website", kind: "package", pricingModel: "fixed", priceSen: 589_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "WEB-CUSTOM", name: "Custom Website", category: "website", kind: "package", pricingModel: "fixed", priceSen: 989_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "LANDING-PAGE", name: "Landing Page", category: "landing_page", kind: "package", pricingModel: "per_unit", priceSen: 200_000, unitLabel: "page", validFrom: from, notes: NOTE },
  { code: "ECOM-BASIC", name: "Basic E-commerce", category: "ecommerce", kind: "package", pricingModel: "fixed", priceSen: 889_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ECOM-PREMIUM", name: "Premium E-commerce", category: "ecommerce", kind: "package", pricingModel: "fixed", priceSen: 1_889_900, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ADD-CUSTOM-FEATURE", name: "Custom Feature", category: "custom_software", kind: "add_on", pricingModel: "per_unit", priceSen: 600_000, unitLabel: "feature", alwaysRequiresTechnicalReview: true, technicalReviewConditions: ["Every custom feature must be scoped by the technical team"], validFrom: from, notes: NOTE },
  { code: "SEO-STARTER", name: "SEO Package (Tier 1)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 900_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "SEO-GROWTH", name: "SEO Package (Tier 2)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 1_600_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "SEO-PREMIUM", name: "SEO Package (Tier 3)", category: "seo", kind: "package", pricingModel: "fixed", priceSen: 3_200_000, maxQuantity: 1, validFrom: from, notes: NOTE },
  { code: "ADD-HOSTING", name: "Hosting", category: "hosting", kind: "add_on", pricingModel: "per_unit", priceSen: 150_000, unitLabel: "year", validFrom: from, notes: NOTE },
  { code: "ADD-MAINTENANCE", name: "Maintenance & Support", category: "maintenance", kind: "add_on", pricingModel: "per_unit", priceSen: 129_900, unitLabel: "month", validFrom: from, notes: NOTE },
  // Not seeded on purpose: "Mobile app from RM55,000" and "Custom e-commerce RM20,000+".
  // "From" prices are not approved prices — those requests go to technical estimation (Class C).
];

async function main() {
  const { db, pool } = createDb();
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@newgen.local";
  let [admin] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!admin) [admin] = await db.insert(users).values({ email: adminEmail, name: "NewGen Admin", role: "admin" }).returning();
  const actor = { id: admin.id, role: admin.role, email: admin.email };

  for (const d of drafts) {
    const row = await createCatalogueDraft(db, actor, d);
    console.log(`draft  ${row.code} v${row.version}`);
  }
  // Empty policy draft: finance must enter milestones, validity days and tax before approval.
  await createPolicyDraft(db, actor, { currency: "MYR", validFrom: from });
  console.log("draft  commercial policy (empty — finance to complete)");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
