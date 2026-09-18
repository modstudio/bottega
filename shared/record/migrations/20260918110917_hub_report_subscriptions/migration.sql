CREATE TABLE "hub_report_subscription" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"project_name" text,
	"person_user_id" uuid,
	"cadence" text NOT NULL,
	"hour" integer NOT NULL,
	"weekday" text,
	"zone" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_person_user_id_user_id_fkey" FOREIGN KEY ("person_user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_recipient_user_id_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id");--> statement-breakpoint
CREATE POLICY "hub_report_subscription_space_select" ON "hub_report_subscription" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_subscription"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_subscription"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_space_insert" ON "hub_report_subscription" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_subscription"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_space_update" ON "hub_report_subscription" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_subscription"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_subscription"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_space_delete" ON "hub_report_subscription" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_subscription"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);