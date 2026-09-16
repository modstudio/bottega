CREATE TABLE "machine" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "membership_space_user_unique" UNIQUE("space_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefixes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"checkout_path" text,
	"stack" text,
	"canon" boolean DEFAULT true NOT NULL,
	"landing_branch" text,
	"production_branch" text,
	"gate" text,
	"require_clean_main" boolean DEFAULT true NOT NULL,
	"color" text,
	"color_dark" text,
	"env_prefix" text,
	"mcp_server" text,
	"mcp_probe_tool" text,
	"tracker" jsonb,
	"worktree_recipe" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_space_name_unique" UNIQUE("space_id","name"),
	CONSTRAINT "project_space_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "seq" (
	"space_id" uuid,
	"project_id" uuid,
	"name" text,
	"next" bigint NOT NULL,
	CONSTRAINT "seq_pkey" PRIMARY KEY("space_id","project_id","name")
);
--> statement-breakpoint
ALTER TABLE "seq" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "space" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_project_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id");--> statement-breakpoint
CREATE POLICY "membership_space_select" ON "membership" AS PERMISSIVE FOR SELECT TO public USING ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "membership_space_insert" ON "membership" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "membership_space_update" ON "membership" AS PERMISSIVE FOR UPDATE TO public USING ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "membership_space_delete" ON "membership" AS PERMISSIVE FOR DELETE TO public USING ("membership"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "project_space_select" ON "project" AS PERMISSIVE FOR SELECT TO public USING ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "project_space_insert" ON "project" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "project_space_update" ON "project" AS PERMISSIVE FOR UPDATE TO public USING ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "project_space_delete" ON "project" AS PERMISSIVE FOR DELETE TO public USING ("project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "seq_space_select" ON "seq" AS PERMISSIVE FOR SELECT TO public USING ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "seq_space_insert" ON "seq" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "seq_space_update" ON "seq" AS PERMISSIVE FOR UPDATE TO public USING ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "seq_space_delete" ON "seq" AS PERMISSIVE FOR DELETE TO public USING ("seq"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_space_select" ON "space" AS PERMISSIVE FOR SELECT TO public USING ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_space_insert" ON "space" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_space_update" ON "space" AS PERMISSIVE FOR UPDATE TO public USING ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_space_delete" ON "space" AS PERMISSIVE FOR DELETE TO public USING ("space"."id" = nullif(current_setting('app.space_id', true), '')::uuid);