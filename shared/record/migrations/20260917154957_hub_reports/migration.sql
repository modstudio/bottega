CREATE TABLE "hub_report_setting" (
	"space_id" uuid PRIMARY KEY,
	"value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_report_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hub_send" (
	"id" uuid PRIMARY KEY,
	"legacy_local_id" bigint,
	"space_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"window" text NOT NULL,
	"recipients" text NOT NULL,
	"projects" text NOT NULL,
	"items" integer NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"test" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"machine" text NOT NULL,
	CONSTRAINT "hub_send_space_legacy_unique" UNIQUE("space_id","legacy_local_id")
);
--> statement-breakpoint
ALTER TABLE "hub_send" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_setting" ADD CONSTRAINT "hub_report_setting_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
CREATE POLICY "hub_report_setting_space_select" ON "hub_report_setting" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_setting_space_insert" ON "hub_report_setting" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_setting_space_update" ON "hub_report_setting" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_setting_space_delete" ON "hub_report_setting" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_setting"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_space_select" ON "hub_send" AS PERMISSIVE FOR SELECT TO public USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_space_insert" ON "hub_send" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_space_update" ON "hub_send" AS PERMISSIVE FOR UPDATE TO public USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_space_delete" ON "hub_send" AS PERMISSIVE FOR DELETE TO public USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);
