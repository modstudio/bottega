CREATE TABLE "question" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"run_id" uuid,
	"workflow_key" text,
	"workflow_cursor_id" bigint,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"question" text NOT NULL,
	"options" jsonb,
	"recommendation" text,
	"why" text,
	"asked_via" text,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	"answerer_kind" text,
	"answer_channel" text,
	"awaiting_operator_at" timestamp with time zone,
	"relayed_by" text,
	"overturned_at" timestamp with time zone,
	"overturned_by" text,
	"overturn_reason" text,
	"replacement" text,
	"filed_as" text,
	"filed_ref" text,
	"filed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "question" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "question_mutation_audit" (
	"question_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_session" text,
	"at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "question_mutation_audit_identity" UNIQUE("question_id","action","at")
);
--> statement-breakpoint
ALTER TABLE "question_mutation_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "question_mutation_audit" ADD CONSTRAINT "question_mutation_audit_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "question_space_select" ON "question" AS PERMISSIVE FOR SELECT TO public USING ("question"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "question"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "question_space_insert" ON "question" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("question"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "question_space_update" ON "question" AS PERMISSIVE FOR UPDATE TO public USING ("question"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("question"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "question_space_delete" ON "question" AS PERMISSIVE FOR DELETE TO public USING ("question"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "question_mutation_audit_space_select" ON "question_mutation_audit" AS PERMISSIVE FOR SELECT TO public USING ("question_mutation_audit"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "question_mutation_audit"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "question_mutation_audit_space_insert" ON "question_mutation_audit" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("question_mutation_audit"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "question_mutation_audit_space_update" ON "question_mutation_audit" AS PERMISSIVE FOR UPDATE TO public USING ("question_mutation_audit"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("question_mutation_audit"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "question_mutation_audit_space_delete" ON "question_mutation_audit" AS PERMISSIVE FOR DELETE TO public USING ("question_mutation_audit"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);