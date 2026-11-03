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

// ---------------------------------------------------------------------------
// QUOTATIONS (Phase 1c)
//   quotations          → one per client opportunity (number, client, owner, overall status)
//   quotation_versions  → each revision; holds scope text, frozen totals and the Finance decision
//   quotation_lines     → priced lines: from the approved price list, or custom (Finance approves)
// ---------------------------------------------------------------------------

/**
 * Reusable terms & conditions wording, maintained by Finance/Admin.
 * A quotation copies the text when a template is chosen, so later template edits
 * never change a quotation that was already sent.
 */
export const termsTemplates = pgTable("terms_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  body: text("body").notNull(),
  /** Pre-filled into every new quotation. At most one (enforced by the database). */
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type TermsTemplate = typeof termsTemplates.$inferSelect;

export const quotationStatusEnum = pgEnum("quotation_status", ["draft", "pending_approval", "approved", "rejected", "cancelled"]);
export const versionStatusEnum = pgEnum("quotation_version_status", ["draft", "submitted", "approved", "rejected", "superseded", "cancelled"]);
export const lineKindEnum = pgEnum("quotation_line_kind", ["catalogue", "custom"]);

export const quotations = pgTable("quotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: text("number").notNull().unique(), // e.g. NGQ-2026-0001
  clientCompany: text("client_company").notNull(),
  clientContactName: text("client_contact_name"),
  clientContactPhone: text("client_contact_phone"),
  clientContactEmail: text("client_contact_email"),
  projectTitle: text("project_title").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  status: quotationStatusEnum("status").notNull().default("draft"),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("quotations_owner_idx").on(t.ownerId), index("quotations_status_idx").on(t.status)]);

export type PolicySnapshot = {
  policyId: string; policyVersion: number; paymentMilestones: PaymentMilestone[];
  quoteValidityDays: number; tax: { label: string; rateBp: number } | null; termsText: string | null;
};

export const quotationVersions = pgTable("quotation_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  quotationId: uuid("quotation_id").notNull().references(() => quotations.id),
  version: integer("version").notNull(),
  status: versionStatusEnum("status").notNull().default("draft"),
  scopeSummary: text("scope_summary"),
  deliverables: jsonb("deliverables").$type<string[]>().notNull().default([]),
  exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
  /** Only printed when filled in; leave blank unless the timeline is confirmed. */
  confirmedTimeline: text("confirmed_timeline"),
  internalNotes: text("internal_notes"),
  /** This client's terms & conditions, as printed on the PDF. Frozen once submitted. */
  termsText: text("terms_text"),
  /** Where the terms came from, so Finance can see what changed: a template… */
  termsTemplateId: uuid("terms_template_id").references(() => termsTemplates.id),
  /** …or a previously approved quotation version for the same client. */
  termsSourceVersionId: uuid("terms_source_version_id").references((): AnyPgColumn => quotationVersions.id),
  /** Set when Quinn drafted this version: questions for the client, gaps, assumptions. Internal only. */
  aiNotes: jsonb("ai_notes").$type<QuinnNotes>(),
  currency: char("currency", { length: 3 }).notNull().default("MYR"),
  // Frozen at submission by the pricing code (never typed by a person):
  subtotalSen: bigint("subtotal_sen", { mode: "number" }),
  taxSen: bigint("tax_sen", { mode: "number" }),
  totalSen: bigint("total_sen", { mode: "number" }),
  policySnapshot: jsonb("policy_snapshot").$type<PolicySnapshot>(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedBy: uuid("submitted_by").references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  validUntil: date("valid_until"),
}, (t) => [uniqueIndex("quotation_version_uq").on(t.quotationId, t.version)]);

export const quotationLines = pgTable("quotation_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: uuid("version_id").notNull().references(() => quotationVersions.id),
  position: integer("position").notNull(),
  kind: lineKindEnum("kind").notNull(),
  catalogueItemId: uuid("catalogue_item_id").references(() => catalogueItems.id),
  catalogueCode: text("catalogue_code"),
  catalogueVersion: integer("catalogue_version"),
  description: text("description").notNull(),
  details: text("details"),
  quantity: integer("quantity").notNull(),
  unitLabel: text("unit_label"),
  /** Custom lines: proposed by Sales, approved by Finance. Catalogue lines: filled by the pricing code. */
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
  assumptions: string[];
};

export type DraftTaskInput = {
  description: string;
  clientCompany: string | null;
  /** A template id, or "none". */
  termsTemplateId: string;
  extraTerms: string | null;
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
