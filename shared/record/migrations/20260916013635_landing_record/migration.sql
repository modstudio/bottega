CREATE TABLE "contention" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"session_id" text,
	"resource_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"event_kind" text NOT NULL,
	"duration_ms" bigint,
	"cause" text,
	"run_id" uuid,
	"landing_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contention_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "contention" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "landing" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"tip" text,
	"trunk_before" text,
	"status" text NOT NULL,
	"error" text,
	"session_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"path_set" jsonb,
	"requested_at" timestamp with time zone,
	"steps" jsonb,
	"causing_landing_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "landing_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "landing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "landing_override" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"tip" text NOT NULL,
	"tree" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "landing_override_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "landing_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "landing_review_carry" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"tip" text NOT NULL,
	"tree" text NOT NULL,
	"review_id" uuid NOT NULL,
	"reviewed_commit" text NOT NULL,
	"reviewed_tree" text NOT NULL,
	"patch_id" text NOT NULL,
	"old_base" text NOT NULL,
	"new_base" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "landing_review_carry_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "landing_review_carry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_flake" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_id" uuid,
	"machine_id" uuid NOT NULL,
	"local_id" bigint NOT NULL,
	"test" text NOT NULL,
	"file" text NOT NULL,
	"load_at_failure" jsonb NOT NULL,
	"signal" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "test_flake_machine_local_unique" UNIQUE("machine_id","local_id")
);
--> statement-breakpoint
ALTER TABLE "test_flake" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contention" ADD CONSTRAINT "contention_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "contention" ADD CONSTRAINT "contention_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "landing" ADD CONSTRAINT "landing_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "landing" ADD CONSTRAINT "landing_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "landing" ADD CONSTRAINT "landing_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "landing_override" ADD CONSTRAINT "landing_override_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "landing_override" ADD CONSTRAINT "landing_override_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "landing_override" ADD CONSTRAINT "landing_override_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "landing_review_carry" ADD CONSTRAINT "landing_review_carry_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "landing_review_carry" ADD CONSTRAINT "landing_review_carry_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "landing_review_carry" ADD CONSTRAINT "landing_review_carry_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
ALTER TABLE "test_flake" ADD CONSTRAINT "test_flake_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "test_flake" ADD CONSTRAINT "test_flake_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "test_flake" ADD CONSTRAINT "test_flake_machine_id_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machine"("id");--> statement-breakpoint
CREATE POLICY "contention_space_select" ON "contention" AS PERMISSIVE FOR SELECT TO public USING ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contention_space_insert" ON "contention" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contention_space_update" ON "contention" AS PERMISSIVE FOR UPDATE TO public USING ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "contention_space_delete" ON "contention" AS PERMISSIVE FOR DELETE TO public USING ("contention"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_space_select" ON "landing" AS PERMISSIVE FOR SELECT TO public USING ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_space_insert" ON "landing" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_space_update" ON "landing" AS PERMISSIVE FOR UPDATE TO public USING ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_space_delete" ON "landing" AS PERMISSIVE FOR DELETE TO public USING ("landing"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_override_space_select" ON "landing_override" AS PERMISSIVE FOR SELECT TO public USING ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_override_space_insert" ON "landing_override" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_override_space_update" ON "landing_override" AS PERMISSIVE FOR UPDATE TO public USING ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_override_space_delete" ON "landing_override" AS PERMISSIVE FOR DELETE TO public USING ("landing_override"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_review_carry_space_select" ON "landing_review_carry" AS PERMISSIVE FOR SELECT TO public USING ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_review_carry_space_insert" ON "landing_review_carry" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_review_carry_space_update" ON "landing_review_carry" AS PERMISSIVE FOR UPDATE TO public USING ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "landing_review_carry_space_delete" ON "landing_review_carry" AS PERMISSIVE FOR DELETE TO public USING ("landing_review_carry"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "test_flake_space_select" ON "test_flake" AS PERMISSIVE FOR SELECT TO public USING ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "test_flake_space_insert" ON "test_flake" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "test_flake_space_update" ON "test_flake" AS PERMISSIVE FOR UPDATE TO public USING ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "test_flake_space_delete" ON "test_flake" AS PERMISSIVE FOR DELETE TO public USING ("test_flake"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);