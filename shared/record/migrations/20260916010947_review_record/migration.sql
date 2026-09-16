CREATE TABLE "review" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"tier" integer,
	"tier_risk" integer,
	"tier_size" integer,
	"tier_reasons" jsonb,
	"tier_reason" text,
	"patch_id" text,
	"path_set" jsonb,
	"commit_message" text,
	"outdated_at" timestamp with time zone,
	"outdated_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_finding" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"review_lens_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"severity" text NOT NULL,
	"location" text NOT NULL,
	"evidence" text NOT NULL,
	"proposed_correction" text NOT NULL,
	"disposition" text,
	"rejection_category" text,
	"triaged_severity" text,
	"triaged_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_finding_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "review_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "review_lens" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"lens" text NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"tree_inspected" text,
	"reviewed_tree" text,
	"standards_read" jsonb NOT NULL,
	"files_covered" jsonb NOT NULL,
	"commands_run" jsonb NOT NULL,
	"could_not_verify" jsonb NOT NULL,
	"mcp_tools" jsonb NOT NULL,
	"docs_read" jsonb NOT NULL,
	"substitutes" jsonb NOT NULL,
	"reproduced" text,
	"coverage" text,
	"limits" text,
	"overlap" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_lens_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "review_lens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "review_finding" ADD CONSTRAINT "review_finding_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "review_finding" ADD CONSTRAINT "review_finding_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "review_lens" ADD CONSTRAINT "review_lens_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "review_lens" ADD CONSTRAINT "review_lens_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "review_space_select" ON "review" AS PERMISSIVE FOR SELECT TO public USING ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_space_insert" ON "review" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_space_update" ON "review" AS PERMISSIVE FOR UPDATE TO public USING ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_space_delete" ON "review" AS PERMISSIVE FOR DELETE TO public USING ("review"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_finding_space_select" ON "review_finding" AS PERMISSIVE FOR SELECT TO public USING ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_finding_space_insert" ON "review_finding" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_finding_space_update" ON "review_finding" AS PERMISSIVE FOR UPDATE TO public USING ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_finding_space_delete" ON "review_finding" AS PERMISSIVE FOR DELETE TO public USING ("review_finding"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_lens_space_select" ON "review_lens" AS PERMISSIVE FOR SELECT TO public USING ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_lens_space_insert" ON "review_lens" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_lens_space_update" ON "review_lens" AS PERMISSIVE FOR UPDATE TO public USING ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "review_lens_space_delete" ON "review_lens" AS PERMISSIVE FOR DELETE TO public USING ("review_lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);