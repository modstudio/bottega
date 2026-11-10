CREATE TABLE "workflow_obligation" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"stage_record_id" uuid NOT NULL,
	"step_ordinal" integer NOT NULL,
	"step_slug" text NOT NULL,
	"floor" text NOT NULL,
	"require_pull_request" boolean DEFAULT false NOT NULL,
	"expected_exit_code" integer DEFAULT 0 NOT NULL,
	"expected_status" text DEFAULT 'done' NOT NULL,
	"floor_deferrable" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"satisfied_at" timestamp with time zone,
	"satisfied_step_ordinal" integer,
	"satisfied_step_slug" text,
	"satisfied_evidence" jsonb,
	"abandoned_at" timestamp with time zone,
	"abandoned_reason" text,
	"operator_ruling" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_obligation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow_step_text" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"stage_record_id" uuid NOT NULL,
	"step_ordinal" integer NOT NULL,
	"step_slug" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_step_text" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow_text_copy" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"workflow_text_record_id" uuid NOT NULL CONSTRAINT "workflow_text_copy_workflow_text_record_id_unique" UNIQUE,
	"stage_record_id" uuid NOT NULL,
	"task_document_reference" text NOT NULL,
	"copied_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_text_copy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_flow" ADD COLUMN "last_request_id" uuid;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "workflow_key" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "instance_id" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "autonomy" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "enforcement" text;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD COLUMN "last_request_id" uuid;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_project_number_unique" UNIQUE("project_id","number");--> statement-breakpoint
CREATE INDEX "task_flow_stage_project_id_idx" ON "task_flow_stage" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_flow_stage_open_slot_unique" ON "task_flow_stage" ("project_id","workflow","mode","workflow_key","instance_id") WHERE "state" NOT IN ('done','abandoned');--> statement-breakpoint
CREATE INDEX "workflow_obligation_stage_record_id_idx" ON "workflow_obligation" ("stage_record_id");--> statement-breakpoint
CREATE INDEX "workflow_step_text_stage_record_id_idx" ON "workflow_step_text" ("stage_record_id");--> statement-breakpoint
CREATE INDEX "workflow_text_copy_stage_record_id_idx" ON "workflow_text_copy" ("stage_record_id");--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "workflow_obligation" ADD CONSTRAINT "workflow_obligation_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_obligation" ADD CONSTRAINT "workflow_obligation_stage_record_id_task_flow_stage_id_fkey" FOREIGN KEY ("stage_record_id") REFERENCES "task_flow_stage"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_step_text" ADD CONSTRAINT "workflow_step_text_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_step_text" ADD CONSTRAINT "workflow_step_text_stage_record_id_task_flow_stage_id_fkey" FOREIGN KEY ("stage_record_id") REFERENCES "task_flow_stage"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_text_copy" ADD CONSTRAINT "workflow_text_copy_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_text_copy" ADD CONSTRAINT "workflow_text_copy_507jlrQqeEPC_fkey" FOREIGN KEY ("workflow_text_record_id") REFERENCES "workflow_step_text"("id");--> statement-breakpoint
ALTER TABLE "workflow_text_copy" ADD CONSTRAINT "workflow_text_copy_stage_record_id_task_flow_stage_id_fkey" FOREIGN KEY ("stage_record_id") REFERENCES "task_flow_stage"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "workflow_obligation_space_select" ON "workflow_obligation" AS PERMISSIVE FOR SELECT TO public USING ("workflow_obligation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow_obligation"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_obligation_space_insert" ON "workflow_obligation" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow_obligation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_obligation"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_obligation_space_update" ON "workflow_obligation" AS PERMISSIVE FOR UPDATE TO public USING (("workflow_obligation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_obligation"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow_obligation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_obligation"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_obligation_space_delete" ON "workflow_obligation" AS PERMISSIVE FOR DELETE TO public USING (("workflow_obligation"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_obligation"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_step_text_space_select" ON "workflow_step_text" AS PERMISSIVE FOR SELECT TO public USING ("workflow_step_text"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow_step_text"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_step_text_space_insert" ON "workflow_step_text" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow_step_text"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_step_text"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_step_text_space_update" ON "workflow_step_text" AS PERMISSIVE FOR UPDATE TO public USING (("workflow_step_text"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_step_text"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow_step_text"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_step_text"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_step_text_space_delete" ON "workflow_step_text" AS PERMISSIVE FOR DELETE TO public USING (("workflow_step_text"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_step_text"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_text_copy_space_select" ON "workflow_text_copy" AS PERMISSIVE FOR SELECT TO public USING ("workflow_text_copy"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow_text_copy"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_text_copy_space_insert" ON "workflow_text_copy" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow_text_copy"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_text_copy"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_text_copy_space_update" ON "workflow_text_copy" AS PERMISSIVE FOR UPDATE TO public USING (("workflow_text_copy"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_text_copy"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow_text_copy"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_text_copy"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_text_copy_space_delete" ON "workflow_text_copy" AS PERMISSIVE FOR DELETE TO public USING (("workflow_text_copy"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_text_copy"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));