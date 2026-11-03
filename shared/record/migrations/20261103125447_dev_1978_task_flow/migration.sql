CREATE TABLE "task_flow" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"state" text NOT NULL,
	"open_stage_record_id" uuid,
	"opening_machine_id" uuid NOT NULL,
	"updated_machine_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_flow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "task_flow_stage" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"flow_record_id" uuid NOT NULL,
	"workflow" text NOT NULL,
	"mode" text NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"catalogue_version_id" uuid NOT NULL,
	"arguments" jsonb NOT NULL,
	"active_ordinal" integer NOT NULL,
	"active_slug" text NOT NULL,
	"state" text NOT NULL,
	"closed_step_notes" jsonb NOT NULL,
	"total_steps" integer NOT NULL,
	"opened_machine_id" uuid NOT NULL,
	"taken_over_from_machine_id" uuid,
	"last_advanced_machine_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_flow_stage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "task_flow_task_id_idx" ON "task_flow" ("task_id");--> statement-breakpoint
CREATE INDEX "task_flow_project_id_idx" ON "task_flow" ("project_id");--> statement-breakpoint
CREATE INDEX "task_flow_open_stage_record_id_idx" ON "task_flow" ("open_stage_record_id");--> statement-breakpoint
CREATE INDEX "task_flow_stage_flow_record_id_idx" ON "task_flow_stage" ("flow_record_id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_opening_machine_id_machine_id_fkey" FOREIGN KEY ("opening_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_updated_machine_id_machine_id_fkey" FOREIGN KEY ("updated_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_flow_record_id_task_flow_id_fkey" FOREIGN KEY ("flow_record_id") REFERENCES "task_flow"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_workflow_version_id_workflow_version_id_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_version"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_sotY1XhA7Z28_fkey" FOREIGN KEY ("catalogue_version_id") REFERENCES "step_catalogue_version"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_opened_machine_id_machine_id_fkey" FOREIGN KEY ("opened_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_taken_over_from_machine_id_machine_id_fkey" FOREIGN KEY ("taken_over_from_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_last_advanced_machine_id_machine_id_fkey" FOREIGN KEY ("last_advanced_machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "task_flow_space_select" ON "task_flow" AS PERMISSIVE FOR SELECT TO public USING ("task_flow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "task_flow"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "task_flow_space_insert" ON "task_flow" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("task_flow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "task_flow_space_update" ON "task_flow" AS PERMISSIVE FOR UPDATE TO public USING (("task_flow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("task_flow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "task_flow_space_delete" ON "task_flow" AS PERMISSIVE FOR DELETE TO public USING (("task_flow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "task_flow_stage_space_select" ON "task_flow_stage" AS PERMISSIVE FOR SELECT TO public USING ("task_flow_stage"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "task_flow_stage"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "task_flow_stage_space_insert" ON "task_flow_stage" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("task_flow_stage"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow_stage"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "task_flow_stage_space_update" ON "task_flow_stage" AS PERMISSIVE FOR UPDATE TO public USING (("task_flow_stage"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow_stage"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("task_flow_stage"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow_stage"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "task_flow_stage_space_delete" ON "task_flow_stage" AS PERMISSIVE FOR DELETE TO public USING (("task_flow_stage"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "task_flow_stage"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));