CREATE TABLE "branch_disposal" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"tip" text NOT NULL,
	"task_key" text,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"archive_ref" text NOT NULL,
	"archive_expires_at" timestamp with time zone NOT NULL,
	"actor_session" text NOT NULL,
	"disposed_at" timestamp with time zone NOT NULL,
	"withheld_fields" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branch_disposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_disposal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "branch_disposal" ADD CONSTRAINT "branch_disposal_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "branch_disposal" ADD CONSTRAINT "branch_disposal_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "branch_disposal" ADD CONSTRAINT "branch_disposal_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "branch_disposal_space_select" ON "branch_disposal" AS PERMISSIVE FOR SELECT TO public USING ("branch_disposal"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "branch_disposal"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "branch_disposal_space_insert" ON "branch_disposal" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("branch_disposal"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "branch_disposal"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "branch_disposal_space_update" ON "branch_disposal" AS PERMISSIVE FOR UPDATE TO public USING (("branch_disposal"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "branch_disposal"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("branch_disposal"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "branch_disposal"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "branch_disposal_space_delete" ON "branch_disposal" AS PERMISSIVE FOR DELETE TO public USING (("branch_disposal"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "branch_disposal"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));
