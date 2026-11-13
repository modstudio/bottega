CREATE TABLE "review_funnel_decision" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"task_key" text,
	"branch" text NOT NULL,
	"head_commit" text NOT NULL,
	"patch_id" text NOT NULL,
	"path_set" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"mode" text NOT NULL,
	"facts_digest" text NOT NULL,
	"facts" jsonb NOT NULL,
	"stack" text,
	"verdict" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"session_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"withheld_fields" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_funnel_decision_mode_check" CHECK ("mode" IN ('evaluate','enforce')),
	CONSTRAINT "review_funnel_decision_outcome_check" CHECK ("outcome" IN ('advice','admit','refuse'))
);
--> statement-breakpoint
ALTER TABLE "review_funnel_decision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "review_funnel_decision_change_idx" ON "review_funnel_decision" ("project_id","task_key","patch_id");--> statement-breakpoint
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "review_funnel_decision_space_select" ON "review_funnel_decision" AS PERMISSIVE FOR SELECT TO public USING ("review_funnel_decision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "review_funnel_decision"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "review_funnel_decision_space_insert" ON "review_funnel_decision" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("review_funnel_decision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "review_funnel_decision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "review_funnel_decision_space_update" ON "review_funnel_decision" AS PERMISSIVE FOR UPDATE TO public USING (("review_funnel_decision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "review_funnel_decision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("review_funnel_decision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "review_funnel_decision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "review_funnel_decision_space_delete" ON "review_funnel_decision" AS PERMISSIVE FOR DELETE TO public USING (("review_funnel_decision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "review_funnel_decision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));