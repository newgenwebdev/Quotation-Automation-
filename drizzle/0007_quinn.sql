CREATE TYPE "public"."agent_task_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"step" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text DEFAULT 'quinn' NOT NULL,
	"kind" text NOT NULL,
	"status" "agent_task_status" DEFAULT 'queued' NOT NULL,
	"requested_by" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"quotation_id" uuid,
	"error" text,
	"error_detail" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "quotation_versions" ADD COLUMN "ai_notes" jsonb;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_task_idx" ON "agent_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_requested_idx" ON "agent_tasks" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_idx" ON "agent_tasks" USING btree ("status");