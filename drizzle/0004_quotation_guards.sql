-- Quotation numbers come from a database sequence, so two people can never get the same number.
CREATE SEQUENCE IF NOT EXISTS quotation_number_seq START 1;
--> statement-breakpoint

ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_qty_pos" CHECK ("quantity" >= 1);
--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_price_nonneg" CHECK ("unit_price_sen" IS NULL OR "unit_price_sen" >= 0);
--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_catalogue_ref" CHECK ("kind" <> 'catalogue' OR ("catalogue_item_id" IS NOT NULL AND "catalogue_code" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_custom_price" CHECK ("kind" <> 'custom' OR "unit_price_sen" IS NOT NULL);
--> statement-breakpoint

-- A submitted, approved or rejected version is frozen. Once a version leaves "draft",
-- only its decision fields may change (and only while it is "submitted").
CREATE OR REPLACE FUNCTION guard_quotation_version() RETURNS trigger AS $$
DECLARE
  decision_cols text[] := ARRAY['status','decided_by','decided_at','decision_note','valid_until','policy_snapshot','subtotal_sen','tax_sen','total_sen','submitted_by','submitted_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: quotation versions cannot be deleted (id=%)', OLD.id;
  END IF;
  IF OLD.status IN ('approved','rejected','cancelled','superseded') THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: a % quotation version cannot be changed (id=%)', OLD.status, OLD.id;
  END IF;
  IF OLD.status = 'submitted' AND (to_jsonb(NEW) - decision_cols) <> (to_jsonb(OLD) - decision_cols) THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: a submitted quotation can only be approved or rejected, not edited (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER quotation_version_frozen BEFORE UPDATE OR DELETE ON "quotation_versions"
  FOR EACH ROW EXECUTE FUNCTION guard_quotation_version();
--> statement-breakpoint

-- Lines can only be added, changed or removed while their version is a draft.
-- Exception: at submission, the pricing code writes prices onto catalogue lines in the same
-- transaction, before the version's status flips — so the check is on the version's status.
CREATE OR REPLACE FUNCTION guard_quotation_line() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_id uuid;
BEGIN
  v_id := COALESCE(NEW.version_id, OLD.version_id);
  SELECT status INTO v_status FROM quotation_versions WHERE id = v_id;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'FROZEN_QUOTATION: lines of a % quotation version cannot be changed', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER quotation_line_frozen BEFORE INSERT OR UPDATE OR DELETE ON "quotation_lines"
  FOR EACH ROW EXECUTE FUNCTION guard_quotation_line();
