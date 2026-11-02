-- SAFETY RULES ENFORCED BY THE DATABASE ITSELF
-- Even if application code has a bug, PostgreSQL will refuse these changes.

-- 1. Sanity checks on catalogue data
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_price_nonneg" CHECK ("price_sen" >= 0);
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_version_pos" CHECK ("version" >= 1);
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_validity_order" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_qty_range" CHECK ("min_quantity" >= 1 AND ("max_quantity" IS NULL OR "max_quantity" >= "min_quantity"));
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_base_plus_units_fields" CHECK (
  "pricing_model" <> 'base_plus_units' OR ("included_units" IS NOT NULL AND "included_units" >= 1 AND "extra_unit_price_sen" IS NOT NULL AND "extra_unit_price_sen" >= 0)
);
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_fixed_qty_one" CHECK ("pricing_model" <> 'fixed' OR ("min_quantity" = 1 AND "max_quantity" = 1));
--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_approval_fields" CHECK ("status" = 'draft' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "policy_tax_fields" CHECK ("tax_enabled" = false OR ("tax_rate_bp" IS NOT NULL AND "tax_rate_bp" >= 0 AND "tax_label" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "policy_approval_fields" CHECK ("status" = 'draft' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));
--> statement-breakpoint

-- 2. Approved prices and policies are frozen.
--    The only allowed change to an approved row is retiring it.
--    To change a price, finance creates a new version.
CREATE OR REPLACE FUNCTION guard_frozen_rows() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'FROZEN_ROW: % rows that were approved cannot be deleted (id=%)', TG_TABLE_NAME, OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'FROZEN_ROW: retired % rows cannot be changed (id=%)', TG_TABLE_NAME, OLD.id;
  END IF;

  IF OLD.status = 'approved' THEN
    IF NEW.status <> 'retired'
       OR (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'FROZEN_ROW: approved % rows can only be retired, not edited (id=%)', TG_TABLE_NAME, OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER catalogue_frozen BEFORE UPDATE OR DELETE ON "catalogue_items"
  FOR EACH ROW EXECUTE FUNCTION guard_frozen_rows();
--> statement-breakpoint
CREATE TRIGGER policy_frozen BEFORE UPDATE OR DELETE ON "commercial_policies"
  FOR EACH ROW EXECUTE FUNCTION guard_frozen_rows();
--> statement-breakpoint

-- 3. The audit log is append-only.
CREATE OR REPLACE FUNCTION guard_audit_log() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY: audit_log rows cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION guard_audit_log();
--> statement-breakpoint

-- 4. Only one approved version of each catalogue code at a time.
CREATE UNIQUE INDEX "catalogue_one_approved_per_code" ON "catalogue_items" ("code") WHERE "status" = 'approved';
--> statement-breakpoint
CREATE UNIQUE INDEX "policy_one_approved_per_code" ON "commercial_policies" ("code") WHERE "status" = 'approved';
