CREATE TABLE "hub_day" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"day" text NOT NULL,
	"claude_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"tasks" integer DEFAULT 0 NOT NULL,
	"canon_tokens" integer DEFAULT 0 NOT NULL,
	"other_tokens" integer DEFAULT 0 NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"lines_product" integer DEFAULT 0 NOT NULL,
	"lines_test" integer DEFAULT 0 NOT NULL,
	"lines_docs" integer DEFAULT 0 NOT NULL,
	"lines_config" integer DEFAULT 0 NOT NULL,
	"lines_generated" integer DEFAULT 0 NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_day_natural_key" UNIQUE("space_id","day")
);
--> statement-breakpoint
ALTER TABLE "hub_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_interval" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"task_key" text,
	"project_name" text,
	"source" text NOT NULL,
	"agent" text,
	"job" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"claude_tokens" integer DEFAULT 0 NOT NULL,
	"vendor_tokens" integer DEFAULT 0 NOT NULL,
	"vendor_cost_usd" double precision,
	"ref" text NOT NULL,
	"via" text,
	"open" integer DEFAULT 0 NOT NULL,
	"session_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_interval_natural_key" UNIQUE("space_id","source","ref","start_at")
);
--> statement-breakpoint
ALTER TABLE "hub_interval" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_day" ADD CONSTRAINT "hub_day_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_interval" ADD CONSTRAINT "hub_interval_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_day_space_select" ON "hub_day" AS PERMISSIVE FOR SELECT TO public USING ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_day_space_insert" ON "hub_day" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_day_space_update" ON "hub_day" AS PERMISSIVE FOR UPDATE TO public USING ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_day_space_delete" ON "hub_day" AS PERMISSIVE FOR DELETE TO public USING ("hub_day"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_interval_space_select" ON "hub_interval" AS PERMISSIVE FOR SELECT TO public USING ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_interval_space_insert" ON "hub_interval" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_interval_space_update" ON "hub_interval" AS PERMISSIVE FOR UPDATE TO public USING ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_interval_space_delete" ON "hub_interval" AS PERMISSIVE FOR DELETE TO public USING ("hub_interval"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);