CREATE TYPE "public"."catalogue_kind" AS ENUM('package', 'add_on');--> statement-breakpoint
CREATE TYPE "public"."catalogue_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."pricing_model" AS ENUM('fixed', 'per_unit', 'base_plus_units');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('sales', 'technical', 'finance', 'admin');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('website', 'landing_page', 'ecommerce', 'mobile_app', 'custom_software', 'ai_automation', 'seo', 'hosting', 'maintenance', 'other');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "catalogue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"category" "service_category" NOT NULL,
	"kind" "catalogue_kind" NOT NULL,
	"currency" char(3) NOT NULL,
	"pricing_model" "pricing_model" NOT NULL,
	"price_sen" bigint NOT NULL,
	"included_units" integer,
	"extra_unit_price_sen" bigint,
	"unit_label" text,
	"min_quantity" integer DEFAULT 1 NOT NULL,
	"max_quantity" integer,
	"inclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision_limit" integer,
	"technical_review_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"always_requires_technical_review" boolean DEFAULT false NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"status" "catalogue_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"supersedes_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commercial_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text DEFAULT 'DEFAULT' NOT NULL,
	"version" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quote_validity_days" integer,
	"tax_enabled" boolean DEFAULT false NOT NULL,
	"tax_label" text,
	"tax_rate_bp" integer,
	"terms_text" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"status" "catalogue_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogue_items" ADD CONSTRAINT "catalogue_items_supersedes_id_catalogue_items_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."catalogue_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "commercial_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commercial_policies" ADD CONSTRAINT "commercial_policies_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_code_version_uq" ON "catalogue_items" USING btree ("code","version");--> statement-breakpoint
CREATE INDEX "catalogue_code_status_idx" ON "catalogue_items" USING btree ("code","status");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_code_version_uq" ON "commercial_policies" USING btree ("code","version");