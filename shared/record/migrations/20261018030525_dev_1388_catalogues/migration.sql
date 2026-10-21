CREATE TABLE "lens" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"excludes" text NOT NULL,
	"slots" text NOT NULL,
	"version" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"requires_execution" boolean DEFAULT false NOT NULL,
	CONSTRAINT "lens_space_key_unique" UNIQUE("space_id","key"),
	CONSTRAINT "lens_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "lens_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "lens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lens_profile" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"lens_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "lens_profile_space_lens_axis_name_unique" UNIQUE("space_id","lens_id","axis","name"),
	CONSTRAINT "lens_profile_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "lens_profile_axis_check" CHECK ("axis" IN ('framework','architecture')),
	CONSTRAINT "lens_profile_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "lens_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lens_profile_revision" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prior_body" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "lens_profile_revision_profile_version_unique" UNIQUE("profile_id","version"),
	CONSTRAINT "lens_profile_revision_version_check" CHECK ("version" > 0),
	CONSTRAINT "lens_profile_revision_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "lens_profile_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lens_revision" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"lens_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prior_body" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "lens_revision_lens_version_unique" UNIQUE("lens_id","version"),
	CONSTRAINT "lens_revision_version_check" CHECK ("version" > 0),
	CONSTRAINT "lens_revision_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "lens_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_lens_profile" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"lens_id" uuid,
	"axis" text NOT NULL,
	"profile_name" text NOT NULL,
	"selected_version" integer,
	CONSTRAINT "project_lens_profile_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "project_lens_profile_axis_check" CHECK ("axis" IN ('framework','architecture')),
	CONSTRAINT "project_lens_profile_selected_version_check" CHECK ("selected_version" IS NULL OR "selected_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "project_lens_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_lens_profile_revision" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"prior_profile_name" text,
	"prior_selected_version" integer,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_lens_profile_revision_selected_version_check" CHECK ("prior_selected_version" IS NULL OR "prior_selected_version" > 0),
	CONSTRAINT "project_lens_profile_revision_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "step_catalogue" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "step_catalogue_space_slug_unique" UNIQUE("space_id","slug"),
	CONSTRAINT "step_catalogue_space_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "step_catalogue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "step_catalogue_event" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"catalogue_version_id" uuid NOT NULL,
	"event" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "step_catalogue_event_event_check" CHECK ("event" IN ('set','fork','import','promote','retire')),
	CONSTRAINT "step_catalogue_event_author_check" CHECK (length(trim("author")) > 0),
	CONSTRAINT "step_catalogue_event_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "step_catalogue_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "step_catalogue_version" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"catalogue_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"status" text NOT NULL,
	"definition" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "step_catalogue_version_catalogue_n_unique" UNIQUE("catalogue_id","n"),
	CONSTRAINT "step_catalogue_version_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "step_catalogue_version_n_check" CHECK ("n" > 0),
	CONSTRAINT "step_catalogue_version_status_check" CHECK ("status" IN ('draft','production','retired')),
	CONSTRAINT "step_catalogue_version_author_check" CHECK (length(trim("author")) > 0),
	CONSTRAINT "step_catalogue_version_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "step_catalogue_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_space_slug_unique" UNIQUE("space_id","slug"),
	CONSTRAINT "workflow_space_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "workflow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow_event" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"event" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_event_event_check" CHECK ("event" IN ('set','fork','import','promote','retire')),
	CONSTRAINT "workflow_event_author_check" CHECK (length(trim("author")) > 0),
	CONSTRAINT "workflow_event_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "workflow_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workflow_version" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"status" text NOT NULL,
	"definition" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workflow_version_workflow_n_unique" UNIQUE("workflow_id","n"),
	CONSTRAINT "workflow_version_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "workflow_version_n_check" CHECK ("n" > 0),
	CONSTRAINT "workflow_version_status_check" CHECK ("status" IN ('draft','production','retired')),
	CONSTRAINT "workflow_version_author_check" CHECK (length(trim("author")) > 0),
	CONSTRAINT "workflow_version_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "workflow_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_baseline" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"pair_id" uuid NOT NULL,
	"source_commit" text,
	"scanned_at" timestamp with time zone,
	CONSTRAINT "port_baseline_space_pair_unique" UNIQUE("space_id","pair_id"),
	CONSTRAINT "port_baseline_scan_check" CHECK (("source_commit" IS NULL) = ("scanned_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "port_baseline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_doctrine" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "port_doctrine_space_number_unique" UNIQUE("space_id","number"),
	CONSTRAINT "port_doctrine_number_check" CHECK ("number" > 0)
);
--> statement-breakpoint
ALTER TABLE "port_doctrine" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_pair" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"source_project_id" uuid NOT NULL,
	"target_project_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "port_pair_space_projects_unique" UNIQUE("space_id","source_project_id","target_project_id"),
	CONSTRAINT "port_pair_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "port_pair_distinct_projects_check" CHECK ("source_project_id" <> "target_project_id")
);
--> statement-breakpoint
ALTER TABLE "port_pair" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_ref" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"target_project_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "port_ref_space_target_task_unique" UNIQUE("space_id","target_project_id","task_key"),
	CONSTRAINT "port_ref_space_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "port_ref" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_ref_source" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"ref_id" uuid NOT NULL,
	"source_project_id" uuid NOT NULL,
	"commits" text NOT NULL,
	"paths" text NOT NULL,
	"note" text NOT NULL,
	CONSTRAINT "port_ref_source_space_ref_source_unique" UNIQUE("space_id","ref_id","source_project_id")
);
--> statement-breakpoint
ALTER TABLE "port_ref_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "port_skip" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"pair_id" uuid NOT NULL,
	"candidate" text NOT NULL,
	"reason" text NOT NULL,
	"skipped_at" timestamp with time zone NOT NULL,
	CONSTRAINT "port_skip_space_pair_candidate_unique" UNIQUE("space_id","pair_id","candidate")
);
--> statement-breakpoint
ALTER TABLE "port_skip" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "project_lens_profile_specific" ON "project_lens_profile" ("space_id","project_id","lens_id","axis") WHERE "lens_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_lens_profile_global" ON "project_lens_profile" ("space_id","project_id","axis") WHERE "lens_id" IS NULL;--> statement-breakpoint
CREATE INDEX "step_catalogue_event_version_idx" ON "step_catalogue_event" ("catalogue_version_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "step_catalogue_version_one_production" ON "step_catalogue_version" ("catalogue_id") WHERE "status" = 'production';--> statement-breakpoint
CREATE INDEX "workflow_event_version_idx" ON "workflow_event" ("workflow_version_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_version_one_production" ON "workflow_version" ("workflow_id") WHERE "status" = 'production';--> statement-breakpoint
CREATE INDEX "port_pair_target_idx" ON "port_pair" ("target_project_id");--> statement-breakpoint
CREATE INDEX "port_skip_pair_idx" ON "port_skip" ("pair_id");--> statement-breakpoint
ALTER TABLE "lens" ADD CONSTRAINT "lens_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "lens_profile" ADD CONSTRAINT "lens_profile_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "lens_profile" ADD CONSTRAINT "lens_profile_same_space_fk" FOREIGN KEY ("space_id","lens_id") REFERENCES "lens"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lens_profile_revision" ADD CONSTRAINT "lens_profile_revision_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "lens_profile_revision" ADD CONSTRAINT "lens_profile_revision_same_space_fk" FOREIGN KEY ("space_id","profile_id") REFERENCES "lens_profile"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lens_revision" ADD CONSTRAINT "lens_revision_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "lens_revision" ADD CONSTRAINT "lens_revision_same_space_fk" FOREIGN KEY ("space_id","lens_id") REFERENCES "lens"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD CONSTRAINT "project_lens_profile_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD CONSTRAINT "project_lens_profile_same_space_project_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_lens_profile" ADD CONSTRAINT "project_lens_profile_same_space_lens_fk" FOREIGN KEY ("space_id","lens_id") REFERENCES "lens"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" ADD CONSTRAINT "project_lens_profile_revision_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "project_lens_profile_revision" ADD CONSTRAINT "project_lens_profile_revision_same_space_fk" FOREIGN KEY ("space_id","selection_id") REFERENCES "project_lens_profile"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "step_catalogue" ADD CONSTRAINT "step_catalogue_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "step_catalogue_event" ADD CONSTRAINT "step_catalogue_event_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "step_catalogue_event" ADD CONSTRAINT "step_catalogue_event_same_space_fk" FOREIGN KEY ("space_id","catalogue_version_id") REFERENCES "step_catalogue_version"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "step_catalogue_version" ADD CONSTRAINT "step_catalogue_version_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "step_catalogue_version" ADD CONSTRAINT "step_catalogue_version_same_space_fk" FOREIGN KEY ("space_id","catalogue_id") REFERENCES "step_catalogue"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_event" ADD CONSTRAINT "workflow_event_same_space_fk" FOREIGN KEY ("space_id","workflow_version_id") REFERENCES "workflow_version"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_same_space_fk" FOREIGN KEY ("space_id","workflow_id") REFERENCES "workflow"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "port_baseline" ADD CONSTRAINT "port_baseline_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_baseline" ADD CONSTRAINT "port_baseline_same_space_pair_fk" FOREIGN KEY ("space_id","pair_id") REFERENCES "port_pair"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "port_doctrine" ADD CONSTRAINT "port_doctrine_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_pair" ADD CONSTRAINT "port_pair_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_pair" ADD CONSTRAINT "port_pair_same_space_source_project_fk" FOREIGN KEY ("space_id","source_project_id") REFERENCES "project"("space_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_pair" ADD CONSTRAINT "port_pair_same_space_target_project_fk" FOREIGN KEY ("space_id","target_project_id") REFERENCES "project"("space_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_ref" ADD CONSTRAINT "port_ref_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_ref" ADD CONSTRAINT "port_ref_same_space_target_project_fk" FOREIGN KEY ("space_id","target_project_id") REFERENCES "project"("space_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD CONSTRAINT "port_ref_source_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD CONSTRAINT "port_ref_source_same_space_ref_fk" FOREIGN KEY ("space_id","ref_id") REFERENCES "port_ref"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "port_ref_source" ADD CONSTRAINT "port_ref_source_same_space_source_project_fk" FOREIGN KEY ("space_id","source_project_id") REFERENCES "project"("space_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "port_skip" ADD CONSTRAINT "port_skip_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "port_skip" ADD CONSTRAINT "port_skip_same_space_pair_fk" FOREIGN KEY ("space_id","pair_id") REFERENCES "port_pair"("space_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "lens_space_select" ON "lens" AS PERMISSIVE FOR SELECT TO public USING ("lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "lens"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "lens_space_insert" ON "lens" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_space_update" ON "lens" AS PERMISSIVE FOR UPDATE TO public USING (("lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_space_delete" ON "lens" AS PERMISSIVE FOR DELETE TO public USING (("lens"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_space_select" ON "lens_profile" AS PERMISSIVE FOR SELECT TO public USING ("lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "lens_profile"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "lens_profile_space_insert" ON "lens_profile" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_space_update" ON "lens_profile" AS PERMISSIVE FOR UPDATE TO public USING (("lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_space_delete" ON "lens_profile" AS PERMISSIVE FOR DELETE TO public USING (("lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_revision_space_select" ON "lens_profile_revision" AS PERMISSIVE FOR SELECT TO public USING ("lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "lens_profile_revision"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "lens_profile_revision_space_insert" ON "lens_profile_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_revision_space_update" ON "lens_profile_revision" AS PERMISSIVE FOR UPDATE TO public USING (("lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_profile_revision_space_delete" ON "lens_profile_revision" AS PERMISSIVE FOR DELETE TO public USING (("lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_revision_space_select" ON "lens_revision" AS PERMISSIVE FOR SELECT TO public USING ("lens_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "lens_revision"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "lens_revision_space_insert" ON "lens_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("lens_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_revision_space_update" ON "lens_revision" AS PERMISSIVE FOR UPDATE TO public USING (("lens_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("lens_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "lens_revision_space_delete" ON "lens_revision" AS PERMISSIVE FOR DELETE TO public USING (("lens_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "lens_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_space_select" ON "project_lens_profile" AS PERMISSIVE FOR SELECT TO public USING ("project_lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "project_lens_profile"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "project_lens_profile_space_insert" ON "project_lens_profile" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("project_lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_space_update" ON "project_lens_profile" AS PERMISSIVE FOR UPDATE TO public USING (("project_lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("project_lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_space_delete" ON "project_lens_profile" AS PERMISSIVE FOR DELETE TO public USING (("project_lens_profile"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_revision_space_select" ON "project_lens_profile_revision" AS PERMISSIVE FOR SELECT TO public USING ("project_lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "project_lens_profile_revision"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "project_lens_profile_revision_space_insert" ON "project_lens_profile_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("project_lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_revision_space_update" ON "project_lens_profile_revision" AS PERMISSIVE FOR UPDATE TO public USING (("project_lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("project_lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "project_lens_profile_revision_space_delete" ON "project_lens_profile_revision" AS PERMISSIVE FOR DELETE TO public USING (("project_lens_profile_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "project_lens_profile_revision"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_space_select" ON "step_catalogue" AS PERMISSIVE FOR SELECT TO public USING ("step_catalogue"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "step_catalogue"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "step_catalogue_space_insert" ON "step_catalogue" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("step_catalogue"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_space_update" ON "step_catalogue" AS PERMISSIVE FOR UPDATE TO public USING (("step_catalogue"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("step_catalogue"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_space_delete" ON "step_catalogue" AS PERMISSIVE FOR DELETE TO public USING (("step_catalogue"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_event_space_select" ON "step_catalogue_event" AS PERMISSIVE FOR SELECT TO public USING ("step_catalogue_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "step_catalogue_event"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "step_catalogue_event_space_insert" ON "step_catalogue_event" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("step_catalogue_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_event_space_update" ON "step_catalogue_event" AS PERMISSIVE FOR UPDATE TO public USING (("step_catalogue_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("step_catalogue_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_event_space_delete" ON "step_catalogue_event" AS PERMISSIVE FOR DELETE TO public USING (("step_catalogue_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_version_space_select" ON "step_catalogue_version" AS PERMISSIVE FOR SELECT TO public USING ("step_catalogue_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "step_catalogue_version"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "step_catalogue_version_space_insert" ON "step_catalogue_version" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("step_catalogue_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_version_space_update" ON "step_catalogue_version" AS PERMISSIVE FOR UPDATE TO public USING (("step_catalogue_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("step_catalogue_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "step_catalogue_version_space_delete" ON "step_catalogue_version" AS PERMISSIVE FOR DELETE TO public USING (("step_catalogue_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "step_catalogue_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_space_select" ON "workflow" AS PERMISSIVE FOR SELECT TO public USING ("workflow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_space_insert" ON "workflow" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_space_update" ON "workflow" AS PERMISSIVE FOR UPDATE TO public USING (("workflow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_space_delete" ON "workflow" AS PERMISSIVE FOR DELETE TO public USING (("workflow"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_event_space_select" ON "workflow_event" AS PERMISSIVE FOR SELECT TO public USING ("workflow_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow_event"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_event_space_insert" ON "workflow_event" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_event_space_update" ON "workflow_event" AS PERMISSIVE FOR UPDATE TO public USING (("workflow_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_event_space_delete" ON "workflow_event" AS PERMISSIVE FOR DELETE TO public USING (("workflow_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_event"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_version_space_select" ON "workflow_version" AS PERMISSIVE FOR SELECT TO public USING ("workflow_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "workflow_version"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "workflow_version_space_insert" ON "workflow_version" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("workflow_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_version_space_update" ON "workflow_version" AS PERMISSIVE FOR UPDATE TO public USING (("workflow_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("workflow_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "workflow_version_space_delete" ON "workflow_version" AS PERMISSIVE FOR DELETE TO public USING (("workflow_version"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "workflow_version"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_baseline_space_select" ON "port_baseline" AS PERMISSIVE FOR SELECT TO public USING ("port_baseline"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_baseline"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_baseline_space_insert" ON "port_baseline" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_baseline"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_baseline"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_baseline_space_update" ON "port_baseline" AS PERMISSIVE FOR UPDATE TO public USING (("port_baseline"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_baseline"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_baseline"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_baseline"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_baseline_space_delete" ON "port_baseline" AS PERMISSIVE FOR DELETE TO public USING (("port_baseline"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_baseline"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_doctrine_space_select" ON "port_doctrine" AS PERMISSIVE FOR SELECT TO public USING ("port_doctrine"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_doctrine"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_doctrine_space_insert" ON "port_doctrine" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_doctrine"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_doctrine"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_doctrine_space_update" ON "port_doctrine" AS PERMISSIVE FOR UPDATE TO public USING (("port_doctrine"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_doctrine"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_doctrine"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_doctrine"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_doctrine_space_delete" ON "port_doctrine" AS PERMISSIVE FOR DELETE TO public USING (("port_doctrine"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_doctrine"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_pair_space_select" ON "port_pair" AS PERMISSIVE FOR SELECT TO public USING ("port_pair"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_pair"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_pair_space_insert" ON "port_pair" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_pair"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_pair"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_pair_space_update" ON "port_pair" AS PERMISSIVE FOR UPDATE TO public USING (("port_pair"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_pair"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_pair"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_pair"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_pair_space_delete" ON "port_pair" AS PERMISSIVE FOR DELETE TO public USING (("port_pair"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_pair"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_space_select" ON "port_ref" AS PERMISSIVE FOR SELECT TO public USING ("port_ref"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_ref"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_ref_space_insert" ON "port_ref" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_ref"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_space_update" ON "port_ref" AS PERMISSIVE FOR UPDATE TO public USING (("port_ref"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_ref"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_space_delete" ON "port_ref" AS PERMISSIVE FOR DELETE TO public USING (("port_ref"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_source_space_select" ON "port_ref_source" AS PERMISSIVE FOR SELECT TO public USING ("port_ref_source"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_ref_source"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_ref_source_space_insert" ON "port_ref_source" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_ref_source"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref_source"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_source_space_update" ON "port_ref_source" AS PERMISSIVE FOR UPDATE TO public USING (("port_ref_source"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref_source"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_ref_source"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref_source"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_ref_source_space_delete" ON "port_ref_source" AS PERMISSIVE FOR DELETE TO public USING (("port_ref_source"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_ref_source"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_skip_space_select" ON "port_skip" AS PERMISSIVE FOR SELECT TO public USING ("port_skip"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "port_skip"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "port_skip_space_insert" ON "port_skip" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("port_skip"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_skip"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_skip_space_update" ON "port_skip" AS PERMISSIVE FOR UPDATE TO public USING (("port_skip"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_skip"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  ))) WITH CHECK (("port_skip"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_skip"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));--> statement-breakpoint
CREATE POLICY "port_skip_space_delete" ON "port_skip" AS PERMISSIVE FOR DELETE TO public USING (("port_skip"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) AND (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.space_id = "port_skip"."space_id"
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.permission = 'write'
  )));