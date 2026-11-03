-- Template names are unique regardless of capitals ("Standard" = "standard").
CREATE UNIQUE INDEX "terms_template_name_uq" ON "terms_templates" (lower("name"));
--> statement-breakpoint
-- At most one default template.
CREATE UNIQUE INDEX "terms_template_one_default" ON "terms_templates" ("is_default") WHERE "is_default" = true;
--> statement-breakpoint
ALTER TABLE "terms_templates" ADD CONSTRAINT "terms_template_body_len" CHECK (char_length("body") BETWEEN 1 AND 20000);
--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_terms_len" CHECK ("terms_text" IS NULL OR char_length("terms_text") <= 20000);
--> statement-breakpoint

-- Keep any wording Finance already typed into the old "Other terms" box on Payment terms:
-- it becomes the default T&C template, so new quotations still start with it.
WITH src AS (
  SELECT terms_text, created_by FROM commercial_policies
  WHERE status = 'approved' AND terms_text IS NOT NULL AND btrim(terms_text) <> ''
  ORDER BY version DESC LIMIT 1
), ins AS (
  INSERT INTO terms_templates (name, body, is_default, created_by)
  SELECT 'Standard terms', left(terms_text, 20000), true, created_by FROM src
  RETURNING id
)
INSERT INTO audit_log (actor_label, action, entity_type, entity_id, reason)
SELECT 'system:migration', 'terms.template_created', 'terms_template', id::text,
       'Moved from the "Other terms" box on Payment terms'
FROM ins;
