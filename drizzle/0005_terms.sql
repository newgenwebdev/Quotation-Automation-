CREATE TABLE "terms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "terms_text" text;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "terms_template_id" uuid;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "terms_source_version_id" uuid;--> statement-breakpoint
ALTER TABLE "terms_templates" ADD CONSTRAINT "terms_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_templates" ADD CONSTRAINT "terms_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_terms_template_id_terms_templates_id_fk" FOREIGN KEY ("terms_template_id") REFERENCES "public"."terms_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD CONSTRAINT "quotation_versions_terms_source_version_id_quotation_versions_id_fk" FOREIGN KEY ("terms_source_version_id") REFERENCES "public"."quotation_versions"("id") ON DELETE no action ON UPDATE no action;