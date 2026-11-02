/**
 * DATABASE SCHEMA — Phase 1 (pricing foundation)
 *
 * Plain-English map of the tables:
 *   users              → who can log in, and their role (Sales / Technical / Finance / Admin)
 *   catalogue_items    → the finance-controlled price list. Every price change creates a
 *                        NEW VERSION row; approved rows are never edited (a DB trigger enforces it).
 *   commercial_policies→ approved payment milestones, quotation validity and tax settings.
 *                        The PDF will only print terms that come from an approved policy.
 *   audit_log          → append-only history of every price change and approval.
 *                        The database refuses to edit or delete rows here.
 *
 * Quotation tables (quotations, versions, line items, approvals, estimate requests,
 * agent tasks) are designed in docs/ARCHITECTURE.md and arrive in later phases.
 *
 * Money is stored as whole "sen" (RM 1.00 = 100 sen) so there are never rounding errors.
 */
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, date, timestamp, jsonb,
  bigserial, char, uniqueIndex, index, type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("user_role", ["sales", "technical", "finance", "admin"]);

export const catalogueStatusEnum = pgEnum("catalogue_status", ["draft", "approved", "retired"]);

/** Package = something sold on its own. Add-on = only sold on top of a package. */
export const catalogueKindEnum = pgEnum("catalogue_kind", ["package", "add_on"]);

/**
 * How a price is calculated. These are structured formulas, not free text,
 * so nobody (human or AI) can sneak arbitrary maths into a price.
 *   fixed           → one price, quantity must be 1
 *   per_unit        → unit price × quantity (e.g. landing pages, custom features)
 *   base_plus_units → base price covers N units; extra units charged per unit
 */
export const pricingModelEnum = pgEnum("pricing_model", ["fixed", "per_unit", "base_plus_units"]);

export const serviceCategoryEnum = pgEnum("service_category", [
  "website", "landing_page", "ecommerce", "mobile_app", "custom_software",
  "ai_automation", "seo", "hosting", "maintenance", "other",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const catalogueItems = pgTable(
  "catalogue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable code shared by all versions, e.g. "WEB-TEMPLATE". */
    code: text("code").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    category: serviceCategoryEnum("category").notNull(),
    kind: catalogueKindEnum("kind").notNull(),
    currency: char("currency", { length: 3 }).notNull(),

    pricingModel: pricingModelEnum("pricing_model").notNull(),
    /** fixed: the price. per_unit: price per unit. base_plus_units: the base price. */
    priceSen: bigint("price_sen", { mode: "number" }).notNull(),
    /** base_plus_units only: units covered by the base price. */
    includedUnits: integer("included_units"),
    /** base_plus_units only: price for each unit above includedUnits. */
    extraUnitPriceSen: bigint("extra_unit_price_sen", { mode: "number" }),
    unitLabel: text("unit_label"), // e.g. "page", "feature", "month"
    minQuantity: integer("min_quantity").notNull().default(1),
    maxQuantity: integer("max_quantity"), // null = no upper limit

    inclusions: jsonb("inclusions").$type<string[]>().notNull().default([]),
    exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
    revisionLimit: integer("revision_limit"), // null = not part of approved terms
    /** Plain-language conditions that send a quote to the technical team. */
    technicalReviewConditions: jsonb("technical_review_conditions").$type<string[]>().notNull().default([]),
    /** true = any quote containing this item always needs technical review. */
    alwaysRequiresTechnicalReview: boolean("always_requires_technical_review").notNull().default(false),

    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"), // null = open-ended

    status: catalogueStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => catalogueItems.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catalogue_code_version_uq").on(t.code, t.version),
    index("catalogue_code_status_idx").on(t.code, t.status),
  ],
);

export type PaymentMilestone = { label: string; percentBp: number }; // basis points: 5000 = 50%

export const commercialPolicies = pgTable(
  "commercial_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().default("DEFAULT"),
    version: integer("version").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    paymentMilestones: jsonb("payment_milestones").$type<PaymentMilestone[]>().notNull().default([]),
    quoteValidityDays: integer("quote_validity_days"),
    taxEnabled: boolean("tax_enabled").notNull().default(false),
    taxLabel: text("tax_label"),
    taxRateBp: integer("tax_rate_bp"), // basis points: 800 = 8%
    termsText: text("terms_text"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    status: catalogueStatusEnum("status").notNull().default("draft"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("policy_code_version_uq").on(t.code, t.version)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id), // null = system / Quinn
    actorLabel: text("actor_label").notNull(), // e.g. "finance:aisyah@…" or "agent:quinn"
    action: text("action").notNull(), // e.g. "catalogue.approved"
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

export type User = typeof users.$inferSelect;
export type Role = User["role"];
export type CatalogueItem = typeof catalogueItems.$inferSelect;
export type CommercialPolicy = typeof commercialPolicies.$inferSelect;
