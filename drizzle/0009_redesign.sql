-- REDESIGN: one Admin role, no Finance approval, statuses Draft / Finalised / Sent / Cancelled,
-- a full quotation editor (overview, objectives, scope lists, timeline, payment terms, discount,
-- tax, project terms, assumptions) and an editable company profile.
--
-- Safety: nothing is deleted. Every status and role change is written to the audit log with its
-- old value. The whole migration runs in one transaction, so it either fully applies or not at all.

-- 0. Lift the freeze on finalised rows while existing data is converted (re-enabled at the end).
ALTER TABLE "quotation_versions" DISABLE TRIGGER "quotation_version_frozen";
--> statement-breakpoint
ALTER TABLE "quotation_lines" DISABLE TRIGGER "quotation_line_frozen";
--> statement-breakpoint

-- 1. Company profile (one row), seeded with the details already printed on quotations.
CREATE TABLE "company_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"registration_no" text,
	"address" text,
	"phone" text,
	"email" text,
	"website" text,
	"bank_name" text,
	"bank_account_name" text,
	"bank_account_no" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_profile_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "company_profile" ("id", "name", "registration_no", "address") VALUES (
  1, 'NewGen Innovation Sdn. Bhd.', '202201030615 (1476312T)',
  E'Seksyen C No. 188, Jalan S2 C9,\nGreen Technology Park Seremban 2,\n70300 Seremban, Negeri Sembilan, Malaysia'
) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- 2. New quotation fields.
ALTER TABLE "quotations" ADD COLUMN "client_address" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "quote_date" date;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "objectives" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "services" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "features" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "technical_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "discount_type" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "discount_value" bigint;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "discount_label" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "tax_label" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "tax_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "discount_sen" bigint;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "timeline_duration" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "timeline_milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "payment_milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "payment_notes" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "project_terms" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "finalised_by" uuid;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "finalised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_finalised_by_users_id_fk" FOREIGN KEY ("finalised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- 3. Status columns become plain text with a CHECK (the default is dropped first so the old types can be removed).
ALTER TABLE "quotations" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quotations" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quotation_versions" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint

-- 4. Record each quotation's old and new status BEFORE changing it.
INSERT INTO "audit_log" ("actor_label", "action", "entity_type", "entity_id", "before", "after", "reason")
SELECT 'system:migration', 'quote.status_migrated', 'quotation', q.id::text,
  jsonb_build_object('status', q.status, 'versionStatus', v.status),
  jsonb_build_object(
    'status', CASE q.status WHEN 'approved' THEN 'finalised' WHEN 'pending_approval' THEN 'draft' WHEN 'rejected' THEN 'draft' ELSE q.status END,
    'versionStatus', CASE
      WHEN v.status = 'approved' THEN 'finalised'
      WHEN v.status IN ('submitted', 'rejected') AND q.status = 'cancelled' THEN 'cancelled'
      WHEN v.status IN ('submitted', 'rejected') THEN 'draft'
      ELSE v.status END),
  'Workflow simplified: Finance approval removed. Statuses are now Draft, Finalised, Sent and Cancelled.'
FROM "quotations" q
JOIN "quotation_versions" v ON v.quotation_id = q.id AND v.version = q.current_version
WHERE q.status IN ('pending_approval', 'approved', 'rejected') OR v.status IN ('submitted', 'approved', 'rejected');
--> statement-breakpoint

-- Every version's old status too (including older revisions), so the change is reversible from the log alone.
INSERT INTO "audit_log" ("actor_label", "action", "entity_type", "entity_id", "before", "after", "reason")
SELECT 'system:migration', 'quote.version_status_migrated', 'quotation_version', v.id::text,
  jsonb_build_object('status', v.status, 'quotationId', v.quotation_id, 'version', v.version, 'totalSen', v.total_sen),
  jsonb_build_object('status', CASE
    WHEN v.status = 'approved' THEN 'finalised'
    WHEN q.status = 'cancelled' THEN 'cancelled'
    WHEN v.version = q.current_version THEN 'draft'
    ELSE 'superseded' END),
  'Workflow simplified: Finance approval removed.'
FROM "quotation_versions" v
JOIN "quotations" q ON q.id = v.quotation_id
WHERE v.status IN ('approved', 'submitted', 'rejected');
--> statement-breakpoint

-- 5. Map the old statuses.
--    approved → finalised. Waiting-for-Finance or sent-back → back to an editable draft.
--    Older versions that were sent back and then replaced by a revision → superseded.
UPDATE "quotation_versions" v SET "status" = CASE
    WHEN v.status = 'approved' THEN 'finalised'
    WHEN q.status = 'cancelled' THEN 'cancelled'
    WHEN v.version = q.current_version THEN 'draft'
    ELSE 'superseded' END
FROM "quotations" q
WHERE q.id = v.quotation_id AND v.status IN ('approved', 'submitted', 'rejected');
--> statement-breakpoint
UPDATE "quotations" SET "status" = CASE "status" WHEN 'approved' THEN 'finalised' ELSE 'draft' END
WHERE "status" IN ('approved', 'pending_approval', 'rejected');
--> statement-breakpoint

-- 6. Fill the new fields from the old ones.
UPDATE "quotation_versions" SET "finalised_by" = "decided_by", "finalised_at" = "decided_at"
WHERE "status" = 'finalised' AND "finalised_at" IS NULL;
--> statement-breakpoint
UPDATE "quotation_versions"
SET "quote_date" = (COALESCE(CASE WHEN "status" = 'finalised' THEN "decided_at" END, "created_at") AT TIME ZONE 'Asia/Kuala_Lumpur')::date
WHERE "quote_date" IS NULL;
--> statement-breakpoint
UPDATE "quotation_versions" SET "timeline_duration" = "confirmed_timeline"
WHERE "confirmed_timeline" IS NOT NULL AND "timeline_duration" IS NULL;
--> statement-breakpoint
-- Payment terms and tax: what Finance approved (frozen snapshot), otherwise the terms in force today.
UPDATE "quotation_versions" SET
  "payment_milestones" = COALESCE("policy_snapshot"->'paymentMilestones', '[]'::jsonb),
  "tax_label" = "policy_snapshot"->'tax'->>'label',
  "tax_rate_bp" = ("policy_snapshot"->'tax'->>'rateBp')::integer
WHERE "policy_snapshot" IS NOT NULL;
--> statement-breakpoint
UPDATE "quotation_versions" v SET
  "payment_milestones" = p.payment_milestones,
  "tax_label" = CASE WHEN p.tax_enabled THEN p.tax_label END,
  "tax_rate_bp" = CASE WHEN p.tax_enabled THEN p.tax_rate_bp END
FROM "commercial_policies" p
WHERE p.code = 'DEFAULT' AND p.status = 'approved' AND v.policy_snapshot IS NULL AND v.status = 'draft';
--> statement-breakpoint
-- Quotations from before per-client T&C printed the payment-terms text; keep printing exactly that.
UPDATE "quotation_versions" SET "terms_text" = "policy_snapshot"->>'termsText'
WHERE "terms_text" IS NULL AND COALESCE("policy_snapshot"->>'termsText', '') <> '';
--> statement-breakpoint
-- Drafts now show a running total too (unpriced lines count as zero until priced).
UPDATE "quotation_versions" v SET
  "subtotal_sen" = s.sub,
  "discount_sen" = 0,
  "tax_sen" = CASE WHEN v.tax_rate_bp IS NULL THEN 0 ELSE (s.sub * v.tax_rate_bp + 5000) / 10000 END,
  "total_sen" = s.sub + CASE WHEN v.tax_rate_bp IS NULL THEN 0 ELSE (s.sub * v.tax_rate_bp + 5000) / 10000 END
FROM (
  SELECT vv.id, COALESCE(SUM(l.line_total_sen), 0)::bigint AS sub
  FROM "quotation_versions" vv LEFT JOIN "quotation_lines" l ON l.version_id = vv.id
  GROUP BY vv.id
) s
WHERE s.id = v.id AND v.status = 'draft';
--> statement-breakpoint
UPDATE "quotation_versions" SET "discount_sen" = 0 WHERE "discount_sen" IS NULL AND "total_sen" IS NOT NULL;
--> statement-breakpoint

-- 7. One role for now: everyone becomes Admin. Old roles are kept in the audit log.
INSERT INTO "audit_log" ("actor_label", "action", "entity_type", "entity_id", "before", "after", "reason")
SELECT 'system:migration', 'user.role_changed', 'user', "id"::text, jsonb_build_object('role', "role"), jsonb_build_object('role', 'admin'),
  'Roles simplified to a single Admin role'
FROM "users" WHERE "role" <> 'admin';
--> statement-breakpoint
UPDATE "users" SET "role" = 'admin' WHERE "role" <> 'admin';
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'admin';
--> statement-breakpoint

-- 8. Rules the database enforces from now on.
ALTER TABLE "quotations" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_status_check" CHECK ("status" IN ('draft', 'finalised', 'sent', 'cancelled'));--> statement-breakpoint
ALTER TABLE "quotation_versions" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_status_check" CHECK ("status" IN ('draft', 'finalised', 'superseded', 'cancelled'));--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_version_discount" CHECK (
  "discount_type" IS NULL OR ("discount_type" IN ('amount', 'percent') AND "discount_value" IS NOT NULL AND "discount_value" >= 0
    AND ("discount_type" <> 'percent' OR "discount_value" <= 10000))
);--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_version_tax" CHECK ("tax_rate_bp" IS NULL OR ("tax_rate_bp" BETWEEN 0 AND 10000 AND "tax_label" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_version_finalised_fields" CHECK ("status" <> 'finalised' OR "finalised_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_version_validity_order" CHECK ("valid_until" IS NULL OR "quote_date" IS NULL OR "valid_until" >= "quote_date");--> statement-breakpoint
-- A line's amount is always quantity × unit price (never typed separately).
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_total_matches" CHECK ("unit_price_sen" IS NULL OR "line_total_sen" = "unit_price_sen" * "quantity");--> statement-breakpoint

-- Finalised (and superseded/cancelled) versions are frozen. A draft can't be finalised
-- while any line still needs a price, or with no lines at all.
CREATE OR REPLACE FUNCTION guard_quotation_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: quotation versions cannot be deleted (id=%)', OLD.id;
  END IF;
  IF OLD.status IN ('finalised', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: a % quotation version cannot be changed (id=%)', OLD.status, OLD.id;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'finalised' THEN
    IF NOT EXISTS (SELECT 1 FROM quotation_lines WHERE version_id = NEW.id) THEN
      RAISE EXCEPTION 'NO_LINES: a quotation needs at least one priced item before it is finalised (id=%)', NEW.id;
    END IF;
    IF EXISTS (SELECT 1 FROM quotation_lines WHERE version_id = NEW.id AND line_total_sen IS NULL) THEN
      RAISE EXCEPTION 'UNPRICED_LINES: every line needs a price before the quotation is finalised (id=%)', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE "quotation_versions" ENABLE TRIGGER "quotation_version_frozen";
--> statement-breakpoint
ALTER TABLE "quotation_lines" ENABLE TRIGGER "quotation_line_frozen";
--> statement-breakpoint

-- 9. The Finance-approval status types are no longer used by any column.
DROP TYPE "public"."quotation_status";--> statement-breakpoint
DROP TYPE "public"."quotation_version_status";--> statement-breakpoint

INSERT INTO "audit_log" ("actor_label", "action", "entity_type", "entity_id", "after", "reason")
SELECT 'system:migration', 'system.workflow_simplified', 'system', '0009_redesign',
  jsonb_build_object(
    'quotations', (SELECT count(*) FROM "quotations"),
    'finalised', (SELECT count(*) FROM "quotations" WHERE "status" = 'finalised'),
    'drafts', (SELECT count(*) FROM "quotations" WHERE "status" = 'draft'),
    'cancelled', (SELECT count(*) FROM "quotations" WHERE "status" = 'cancelled'),
    'users', (SELECT count(*) FROM "users")),
  'Single Admin role; Finance approval removed; statuses Draft / Finalised / Sent / Cancelled';
