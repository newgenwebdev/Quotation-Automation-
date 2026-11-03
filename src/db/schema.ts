/**
 * DATABASE SCHEMA
 *
 * Plain-English map of the tables:
 *   users              → who can sign in. Everyone is an Admin for now (one role, see permissions.ts).
 *   company_profile    → NewGen's details printed on every quotation (Settings → Company profile).
 *   catalogue_items    → the price list. Every price change creates a NEW VERSION row, so old
 *                        quotations keep pointing at the price they used (a DB trigger freezes old rows).
 *   commercial_policies→ default payment milestones, quotation validity and tax (Settings → Payment terms).
 *   terms_templates    → standard T&C wording (Settings → T&C templates).
 *   quotations / quotation_versions / quotation_lines → the quotations themselves.
 *   audit_log          → append-only history of every change. The database refuses edits/deletes.
 *   agent_tasks / agent_events → Quinn's work and its step-by-step trail.
 *
 * Money is stored as whole "sen" (RM 1.00 = 100 sen) so there are never rounding errors.
 * Percentages are stored as basis points (50% = 5000).
 */
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, date, timestamp, jsonb,
  bigserial, char, uniqueIndex, index, type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * The old Sales / Technical / Finance values stay in the database type so historical audit
 * entries still make sense, but every account was moved to "admin" (migration 0009) and new
 * accounts are always created as "admin".
 */
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
  role: roleEnum("role").notNull().default("admin"),
  active: boolean("active").notNull().default(true),
  /** scrypt hash. Null until the person opens their setup link and chooses a password. */
  passwordHash: text("password_hash"),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Logged-in browser sessions. Only a hash of the cookie value is stored. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/** One-time links for a new user to set (or reset) their password. Only a hash is stored. */
export const setupTokens = pgTable("setup_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
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

/** NewGen's own details, printed on every quotation. Exactly one row (id = 1). */
export const companyProfile = pgTable("company_profile", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull(),
  registrationNo: text("registration_no"),
  /** Several lines, printed as written. */
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  /** Printed under "Payment details" only when all three are filled in. */
  bankName: text("bank_name"),
  bankAccountName: text("bank_account_name"),
  bankAccountNo: text("bank_account_no"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CompanyProfile = typeof companyProfile.$inferSelect;

// ---------------------------------------------------------------------------
// QUOTATIONS
//   quotations          → one per client opportunity (number, client, creator, overall status)
//   quotation_versions  → each revision: every section of the quotation, with its totals
//   quotation_lines     → the pricing table (from the price list, or entered by hand)
//
//   Quotation status: draft → finalised → sent   (or cancelled at any point)
//   A finalised version is frozen by the database. "Edit" on a finalised quotation starts a
//   new draft version; the finalised one stays as a record.
// ---------------------------------------------------------------------------

/**
 * Reusable terms & conditions wording, maintained in Settings.
 * A quotation copies the text when a template is chosen, so later template edits
 * never change a quotation that was already sent.
 */
export const termsTemplates = pgTable("terms_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  /** Applied automatically to every new quotation. At most one (enforced by the database). */
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type TermsTemplate = typeof termsTemplates.$inferSelect;

export const QUOTE_STATUSES = ["draft", "finalised", "sent", "cancelled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
/** "sent" is tracked on the quotation; a version is only ever draft, finalised, superseded or cancelled. */
export const VERSION_STATUSES = ["draft", "finalised", "superseded", "cancelled"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const lineKindEnum = pgEnum("quotation_line_kind", ["catalogue", "custom"]);

export const quotations = pgTable("quotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: text("number").notNull().unique(), // e.g. NGQ-2026-0001
  clientCompany: text("client_company").notNull(),
  clientContactName: text("client_contact_name"),
  clientContactPhone: text("client_contact_phone"),
  clientContactEmail: text("client_contact_email"),
  clientAddress: text("client_address"),
  projectTitle: text("project_title").notNull(),
  /** The person who created the quotation ("Created by"). Never changes. */
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  status: text("status").$type<QuoteStatus>().notNull().default("draft"),
  currentVersion: integer("current_version").notNull().default(1),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("quotations_owner_idx").on(t.ownerId), index("quotations_status_idx").on(t.status)]);

/** Legacy (before migration 0009): payment terms copied in when Finance approved a version. */
export type PolicySnapshot = {
  policyId: string; policyVersion: number; paymentMilestones: PaymentMilestone[];
  quoteValidityDays: number; tax: { label: string; rateBp: number } | null; termsText: string | null;
};

export type TimelineMilestone = { label: string; timing: string };

export const quotationVersions = pgTable("quotation_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  quotationId: uuid("quotation_id").notNull().references(() => quotations.id),
  version: integer("version").notNull(),
  status: text("status").$type<VersionStatus>().notNull().default("draft"),
  // 1. Quotation information
  quoteDate: date("quote_date"),
  validUntil: date("valid_until"),
  // 3. Project
  /** "Project overview" on screen and on the PDF. */
  scopeSummary: text("scope_summary"),
  objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
  // 4. Scope of work
  services: jsonb("services").$type<string[]>().notNull().default([]),
  features: jsonb("features").$type<string[]>().notNull().default([]),
  technicalRequirements: jsonb("technical_requirements").$type<string[]>().notNull().default([]),
  deliverables: jsonb("deliverables").$type<string[]>().notNull().default([]),
  exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
  // 5. Pricing (totals are always calculated by the server, never typed)
  discountType: text("discount_type").$type<"amount" | "percent">(),
  /** sen for "amount", basis points for "percent". */
  discountValue: bigint("discount_value", { mode: "number" }),
  discountLabel: text("discount_label"),
  taxLabel: text("tax_label"),
  taxRateBp: integer("tax_rate_bp"),
  currency: char("currency", { length: 3 }).notNull().default("MYR"),
  subtotalSen: bigint("subtotal_sen", { mode: "number" }),
  discountSen: bigint("discount_sen", { mode: "number" }),
  taxSen: bigint("tax_sen", { mode: "number" }),
  totalSen: bigint("total_sen", { mode: "number" }),
  // 6. Timeline
  timelineDuration: text("timeline_duration"),
  timelineMilestones: jsonb("timeline_milestones").$type<TimelineMilestone[]>().notNull().default([]),
  // 7. Payment terms
  paymentMilestones: jsonb("payment_milestones").$type<PaymentMilestone[]>().notNull().default([]),
  paymentNotes: text("payment_notes"),
  // 8. Terms & conditions
  /** The standard T&C text (usually from a template), as printed. */
  termsText: text("terms_text"),
  /** Where the standard terms came from: a template… */
  termsTemplateId: uuid("terms_template_id").references(() => termsTemplates.id),
  /** …or an earlier quotation for the same client. */
  termsSourceVersionId: uuid("terms_source_version_id").references((): AnyPgColumn => quotationVersions.id),
  projectTerms: text("project_terms"),
  assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
  // Internal only — never printed
  internalNotes: text("internal_notes"),
  /** Set when Quinn drafted this version: questions for the client, gaps, guesses to check. */
  aiNotes: jsonb("ai_notes").$type<QuinnNotes>(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalisedBy: uuid("finalised_by").references(() => users.id),
  finalisedAt: timestamp("finalised_at", { withTimezone: true }),
  // Legacy (before migration 0009, when Finance approved every quotation). Kept as history.
  confirmedTimeline: text("confirmed_timeline"),
  policySnapshot: jsonb("policy_snapshot").$type<PolicySnapshot>(),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
}, (t) => [uniqueIndex("quotation_version_uq").on(t.quotationId, t.version)]);

export const quotationLines = pgTable("quotation_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull().references(() => quotationVersions.id),
  position: integer("position").notNull(),
  /** "catalogue" = taken from the price list at its listed price; "custom" = entered or changed by hand. */
  kind: lineKindEnum("kind").notNull(),
  catalogueItemId: uuid("catalogue_item_id").references(() => catalogueItems.id),
  catalogueCode: text("catalogue_code"),
  catalogueVersion: integer("catalogue_version"),
  /** Service category (website, mobile_app…), when known. */
  category: text("category"),
  description: text("description").notNull(),
  details: text("details"),
  quantity: integer("quantity").notNull(),
  unitLabel: text("unit_label"),
  /** null = "Price review required": the quotation can't be finalised until someone enters it. */
  unitPriceSen: bigint("unit_price_sen", { mode: "number" }),
  lineTotalSen: bigint("line_total_sen", { mode: "number" }),
}, (t) => [index("quotation_lines_version_idx").on(t.versionId)]);

export type Quotation = typeof quotations.$inferSelect;
export type QuotationVersion = typeof quotationVersions.$inferSelect;
export type QuotationLine = typeof quotationLines.$inferSelect;

// ---------------------------------------------------------------------------
// QUINN (AI employee) — every piece of work is a task with a visible trail of events.
// The Virtual Office will later show Quinn's state from these real records.
// ---------------------------------------------------------------------------

export type QuinnNotes = {
  taskId: string;
  model: string;
  generatedAt: string;
  clarificationQuestions: string[];
  missingInformation: string[];
  /** Things Quinn had to guess or wasn't sure about. Shown as "check these". */
  assumptions: string[];
  /** Which items were priced from the price list and which need a price review. */
  pricingNotes?: string[];
};

export type DraftTaskInput = {
  description: string;
  clientCompany: string | null;
  /** Legacy (before the redesign the person chose a T&C template). Now the default template is used. */
  termsTemplateId?: string;
  extraTerms?: string | null;
};

export const agentTaskStatusEnum = pgEnum("agent_task_status", ["queued", "running", "succeeded", "failed"]);

export const agentTasks = pgTable("agent_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  agent: text("agent").notNull().default("quinn"),
  kind: text("kind").notNull(), // "draft_quotation"
  status: agentTaskStatusEnum("status").notNull().default("queued"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  input: jsonb("input").$type<DraftTaskInput>().notNull(),
  quotationId: uuid("quotation_id").references(() => quotations.id),
  /** Plain-English reason shown to the user. */
  error: text("error"),
  /** Technical detail for Admins. */
  errorDetail: text("error_detail"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("agent_tasks_requested_idx").on(t.requestedBy, t.createdAt), index("agent_tasks_status_idx").on(t.status)]);

export const agentEvents = pgTable("agent_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  taskId: uuid("task_id").notNull().references(() => agentTasks.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  /** reading | drafting | saving | done | failed */
  step: text("step").notNull(),
  message: text("message").notNull(),
}, (t) => [index("agent_events_task_idx").on(t.taskId)]);

export type AgentTask = typeof agentTasks.$inferSelect;
export type AgentEvent = typeof agentEvents.$inferSelect;
