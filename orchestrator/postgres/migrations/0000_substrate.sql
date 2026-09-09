CREATE TABLE "space" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "membership_space_user_unique" UNIQUE("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "machine" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
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
	"mcp_server" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_space_name_unique" UNIQUE("space_id","name"),
	CONSTRAINT "project_space_id_unique" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "seq" (
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"next" bigint NOT NULL,
	CONSTRAINT "seq_space_id_project_id_name_pk" PRIMARY KEY("space_id","project_id","name")
);
--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "space"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "machine" ADD CONSTRAINT "machine_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "space"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "space"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_project_fk" FOREIGN KEY ("space_id","project_id") REFERENCES "project"("space_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

INSERT INTO "space" ("id", "name", "created_at")
VALUES ('01990000-0000-7000-8000-000000000001', 'bottega', '2026-09-09T00:00:00Z');
--> statement-breakpoint

ALTER TABLE "space" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "space" FORCE ROW LEVEL SECURITY;
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;
ALTER TABLE "seq" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seq" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "space_space_select" ON "space" FOR SELECT USING (
  "id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "space_space_insert" ON "space" FOR INSERT WITH CHECK (
  "id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "space_space_update" ON "space" FOR UPDATE USING (
  "id" = nullif(current_setting('app.space_id', true), '')::uuid
) WITH CHECK (
  "id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "space_space_delete" ON "space" FOR DELETE USING (
  "id" = nullif(current_setting('app.space_id', true), '')::uuid
);
--> statement-breakpoint

CREATE POLICY "membership_space_select" ON "membership" FOR SELECT USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "membership_space_insert" ON "membership" FOR INSERT WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "membership_space_update" ON "membership" FOR UPDATE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
) WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "membership_space_delete" ON "membership" FOR DELETE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
--> statement-breakpoint

CREATE POLICY "project_space_select" ON "project" FOR SELECT USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "project_space_insert" ON "project" FOR INSERT WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "project_space_update" ON "project" FOR UPDATE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
) WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "project_space_delete" ON "project" FOR DELETE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
--> statement-breakpoint

CREATE POLICY "seq_space_select" ON "seq" FOR SELECT USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "seq_space_insert" ON "seq" FOR INSERT WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "seq_space_update" ON "seq" FOR UPDATE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
) WITH CHECK (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
CREATE POLICY "seq_space_delete" ON "seq" FOR DELETE USING (
  "space_id" = nullif(current_setting('app.space_id', true), '')::uuid
);
