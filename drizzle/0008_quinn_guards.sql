-- Quinn can draft custom lines without a price; a person fills the price in before submitting.
ALTER TABLE "quotation_lines" DROP CONSTRAINT IF EXISTS "quotation_line_custom_price";
--> statement-breakpoint
-- A custom line is either fully priced (unit price and total) or not priced at all.
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_custom_priced_together"
  CHECK ("kind" <> 'custom' OR (("unit_price_sen" IS NULL) = ("line_total_sen" IS NULL)));
--> statement-breakpoint
-- Price-list lines are always priced by the pricing engine.
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_line_catalogue_priced"
  CHECK ("kind" <> 'catalogue' OR "line_total_sen" IS NOT NULL);
--> statement-breakpoint

-- Same freeze rules as before, plus: a version can't be submitted while any line has no price.
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
  IF OLD.status = 'draft' AND NEW.status = 'submitted'
     AND EXISTS (SELECT 1 FROM quotation_lines WHERE version_id = NEW.id AND line_total_sen IS NULL) THEN
    RAISE EXCEPTION 'UNPRICED_LINES: every line needs a price before submission (id=%)', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_task_kind" CHECK ("kind" IN ('draft_quotation'));
--> statement-breakpoint
-- Task events are an append-only trail.
CREATE OR REPLACE FUNCTION guard_agent_events() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AGENT_EVENTS_APPEND_ONLY: agent events cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_events_append_only BEFORE UPDATE OR DELETE ON "agent_events"
  FOR EACH ROW EXECUTE FUNCTION guard_agent_events();
