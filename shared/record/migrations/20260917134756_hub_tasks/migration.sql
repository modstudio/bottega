CREATE TABLE "hub_task" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"key" text NOT NULL,
	"project" text NOT NULL,
	"title" text,
	"status" text,
	"status_category" text,
	"parent_key" text,
	"body" text,
	"assignee" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"source" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_task_space_key_unique" UNIQUE("space_id","key")
);
--> statement-breakpoint
ALTER TABLE "hub_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_task_comment" (
	"id" uuid PRIMARY KEY,
	"legacy_local_id" bigint,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"task_key" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_task_comment_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "hub_task_comment_legacy_unique" UNIQUE("space_id","legacy_local_id")
);
--> statement-breakpoint
ALTER TABLE "hub_task_comment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_task_document" (
	"id" uuid PRIMARY KEY,
	"legacy_local_id" bigint,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"task_key" text NOT NULL,
	"role" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_task_document_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "hub_task_document_legacy_unique" UNIQUE("space_id","legacy_local_id")
);
--> statement-breakpoint
ALTER TABLE "hub_task_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_task_status_event" (
	"id" uuid PRIMARY KEY,
	"legacy_local_id" bigint,
	"space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"task_key" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hub_task_status_event_space_id_unique" UNIQUE("space_id","id"),
	CONSTRAINT "hub_task_status_event_legacy_unique" UNIQUE("space_id","legacy_local_id"),
	CONSTRAINT "hub_task_status_event_change_unique" UNIQUE("space_id","task_key","to_status","at")
);
--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_task" ADD CONSTRAINT "hub_task_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD CONSTRAINT "hub_task_comment_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD CONSTRAINT "hub_task_document_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD CONSTRAINT "hub_task_status_event_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_task_space_select" ON "hub_task" AS PERMISSIVE FOR SELECT TO public USING ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_space_insert" ON "hub_task" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_space_update" ON "hub_task" AS PERMISSIVE FOR UPDATE TO public USING ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_space_delete" ON "hub_task" AS PERMISSIVE FOR DELETE TO public USING ("hub_task"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_comment_space_select" ON "hub_task_comment" AS PERMISSIVE FOR SELECT TO public USING ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_comment_space_insert" ON "hub_task_comment" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_comment_space_update" ON "hub_task_comment" AS PERMISSIVE FOR UPDATE TO public USING ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_comment_space_delete" ON "hub_task_comment" AS PERMISSIVE FOR DELETE TO public USING ("hub_task_comment"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_document_space_select" ON "hub_task_document" AS PERMISSIVE FOR SELECT TO public USING ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_document_space_insert" ON "hub_task_document" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_document_space_update" ON "hub_task_document" AS PERMISSIVE FOR UPDATE TO public USING ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_document_space_delete" ON "hub_task_document" AS PERMISSIVE FOR DELETE TO public USING ("hub_task_document"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_status_event_space_select" ON "hub_task_status_event" AS PERMISSIVE FOR SELECT TO public USING ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_status_event_space_insert" ON "hub_task_status_event" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_status_event_space_update" ON "hub_task_status_event" AS PERMISSIVE FOR UPDATE TO public USING ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_task_status_event_space_delete" ON "hub_task_status_event" AS PERMISSIVE FOR DELETE TO public USING ("hub_task_status_event"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);