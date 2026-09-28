CREATE TABLE "review_read" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"tip" text NOT NULL,
	"patch_id" text NOT NULL,
	"path_set" jsonb NOT NULL,
	"tier" integer NOT NULL,
	"note" text NOT NULL,
	"session_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_read_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "review_read" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD COLUMN "admission_path" text DEFAULT 'exact_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD COLUMN "read_id" uuid;--> statement-breakpoint
ALTER TABLE "review_read" ADD CONSTRAINT "review_read_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "review_read" ADD CONSTRAINT "review_read_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "review_read" ADD CONSTRAINT "review_read_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "review_read_space_select" ON "review_read" AS PERMISSIVE FOR SELECT TO public USING ("review_read"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "review_read"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "review_read_space_insert" ON "review_read" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("review_read"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_read_space_update" ON "review_read" AS PERMISSIVE FOR UPDATE TO public USING ("review_read"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("review_read"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_read_space_delete" ON "review_read" AS PERMISSIVE FOR DELETE TO public USING ("review_read"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);