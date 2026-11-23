CREATE TABLE "space_agent" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"harness" text NOT NULL,
	"backend" text,
	"model" text NOT NULL,
	"base_url" text,
	"transport" text NOT NULL,
	"provider" text,
	"api_key_secret" text,
	"request_settings" jsonb,
	"jobs" jsonb,
	"preferred_jobs" jsonb,
	"max_concurrent" integer,
	"route_metered" boolean NOT NULL,
	"trains_on_inputs" boolean NOT NULL,
	"operated_by" text NOT NULL,
	"billing" text NOT NULL,
	CONSTRAINT "space_agent_space_name_unique" UNIQUE("space_id","name")
);
--> statement-breakpoint
ALTER TABLE "space_agent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "space_agent_space_select" ON "space_agent" AS PERMISSIVE FOR SELECT TO public USING ("space_agent"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "space_agent"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "space_agent_space_insert" ON "space_agent" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("space_agent"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "space_agent"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "space_agent_space_update" ON "space_agent" AS PERMISSIVE FOR UPDATE TO public USING (("space_agent"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "space_agent"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("space_agent"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "space_agent"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "space_agent_space_delete" ON "space_agent" AS PERMISSIVE FOR DELETE TO public USING (("space_agent"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "space_agent"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));