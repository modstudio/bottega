CREATE TABLE "landing_triage_snapshot" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"tip" text NOT NULL,
	"tree" text NOT NULL,
	"pr_number" integer NOT NULL,
	"review_ids" jsonb NOT NULL,
	"patch_id" text NOT NULL,
	"tier" integer NOT NULL,
	"lens_rounds" integer NOT NULL,
	"finding_count" integer NOT NULL,
	"override_id" uuid,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "landing_triage_snapshot_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD CONSTRAINT "landing_triage_snapshot_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD CONSTRAINT "landing_triage_snapshot_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD CONSTRAINT "landing_triage_snapshot_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "landing_triage_snapshot_space_select" ON "landing_triage_snapshot" AS PERMISSIVE FOR SELECT TO public USING ("landing_triage_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "landing_triage_snapshot"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "landing_triage_snapshot_space_insert" ON "landing_triage_snapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("landing_triage_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_triage_snapshot_space_update" ON "landing_triage_snapshot" AS PERMISSIVE FOR UPDATE TO public USING ("landing_triage_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("landing_triage_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_triage_snapshot_space_delete" ON "landing_triage_snapshot" AS PERMISSIVE FOR DELETE TO public USING ("landing_triage_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "landing_triage_snapshot" TO record_actor;
