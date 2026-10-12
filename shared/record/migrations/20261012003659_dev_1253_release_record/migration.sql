CREATE TABLE "release" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"rung" text NOT NULL,
	"candidate_commit" text NOT NULL,
	"live_commit_before" text,
	"live_commit_after" text,
	"rollback" boolean NOT NULL,
	"rollback_reason" text,
	"actor" text NOT NULL,
	"session_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"live_matches_candidate" boolean,
	"warning" text,
	"withheld_fields" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "release" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "release_space_select" ON "release" AS PERMISSIVE FOR SELECT TO public USING ("release"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "release"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "release_space_insert" ON "release" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("release"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "release"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "release_space_update" ON "release" AS PERMISSIVE FOR UPDATE TO public USING (("release"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "release"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("release"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "release"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "release_space_delete" ON "release" AS PERMISSIVE FOR DELETE TO public USING (("release"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "release"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));