CREATE TABLE "orch_snapshot" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"machine_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orch_snapshot_latest_per_machine" UNIQUE("space_id","kind","machine_id"),
	CONSTRAINT "orch_snapshot_kind_check" CHECK ("kind" IN ('state','blockers','health','jobs','agents'))
);
--> statement-breakpoint
ALTER TABLE "orch_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orch_snapshot" ADD CONSTRAINT "orch_snapshot_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "orch_snapshot_space_select" ON "orch_snapshot" AS PERMISSIVE FOR SELECT TO public USING ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "orch_snapshot_space_insert" ON "orch_snapshot" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "orch_snapshot_space_update" ON "orch_snapshot" AS PERMISSIVE FOR UPDATE TO public USING ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "orch_snapshot_space_delete" ON "orch_snapshot" AS PERMISSIVE FOR DELETE TO public USING ("orch_snapshot"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);