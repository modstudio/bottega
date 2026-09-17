CREATE TABLE "run_exclusion" (
	"run_id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"excluded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_exclusion" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "doc" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject" text,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"delivery" text NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "doc_scope_check" CHECK ("scope" IN ('project','machine','agent','job','global','stack','resume','canon')),
	CONSTRAINT "doc_delivery_check" CHECK ("delivery" IN ('inject','demand')),
	CONSTRAINT "doc_subject_check" CHECK ((
  ("scope" IN ('machine','global') AND "subject" IS NULL) OR
  ("scope" IN ('project','stack','agent','job','resume') AND "subject" IS NOT NULL) OR
  "scope" = 'canon'
)),
	CONSTRAINT "doc_slug_check" CHECK ((
  ("scope" = 'canon' AND length("slug") > 0 AND "slug" NOT LIKE '/%' AND "slug" NOT LIKE '%..%') OR
  ("scope" <> 'canon' AND length("slug") <= 64 AND "slug" ~ '^[a-z0-9][a-z0-9-]*$')
))
);
--> statement-breakpoint
ALTER TABLE "doc" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "doc_revision" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject" text,
	"slug" text NOT NULL,
	"project_id" uuid,
	"op" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"delivery" text NOT NULL,
	"author" text NOT NULL,
	"reason" text NOT NULL,
	"session_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "doc_revision_scope_check" CHECK ("scope" IN ('project','machine','agent','job','global','stack','resume','canon')),
	CONSTRAINT "doc_revision_delivery_check" CHECK ("delivery" IN ('inject','demand')),
	CONSTRAINT "doc_revision_op_check" CHECK ("op" IN ('create','set','consume','delete','restore','import','backfill')),
	CONSTRAINT "doc_revision_subject_check" CHECK ((
  ("scope" IN ('machine','global') AND "subject" IS NULL) OR
  ("scope" IN ('project','stack','agent','job','resume') AND "subject" IS NOT NULL) OR
  "scope" = 'canon'
)),
	CONSTRAINT "doc_revision_slug_check" CHECK ((
  ("scope" = 'canon' AND length("slug") > 0 AND "slug" NOT LIKE '/%' AND "slug" NOT LIKE '%..%') OR
  ("scope" <> 'canon' AND length("slug") <= 64 AND "slug" ~ '^[a-z0-9][a-z0-9-]*$')
)),
	CONSTRAINT "doc_revision_author_check" CHECK (length(trim("author")) > 0),
	CONSTRAINT "doc_revision_reason_check" CHECK (length(trim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "doc_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_live_address" ON "doc" ("space_id","scope",COALESCE("subject", ''),"slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_updated_at" ON "doc" ("space_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_revision_identity" ON "doc_revision" ("space_id","doc_id","at","op","author","reason");--> statement-breakpoint
ALTER TABLE "run_exclusion" ADD CONSTRAINT "run_exclusion_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
CREATE POLICY "run_exclusion_space_select" ON "run_exclusion" AS PERMISSIVE FOR SELECT TO public USING ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_exclusion_space_insert" ON "run_exclusion" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_exclusion_space_update" ON "run_exclusion" AS PERMISSIVE FOR UPDATE TO public USING ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "run_exclusion_space_delete" ON "run_exclusion" AS PERMISSIVE FOR DELETE TO public USING ("run_exclusion"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_space_select" ON "doc" AS PERMISSIVE FOR SELECT TO public USING ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_space_insert" ON "doc" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_space_update" ON "doc" AS PERMISSIVE FOR UPDATE TO public USING ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_space_delete" ON "doc" AS PERMISSIVE FOR DELETE TO public USING ("doc"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_revision_space_select" ON "doc_revision" AS PERMISSIVE FOR SELECT TO public USING ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_revision_space_insert" ON "doc_revision" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_revision_space_update" ON "doc_revision" AS PERMISSIVE FOR UPDATE TO public USING ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "doc_revision_space_delete" ON "doc_revision" AS PERMISSIVE FOR DELETE TO public USING ("doc_revision"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);