CREATE TABLE "hub_report_subscription_member" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_report_subscription_member_unique" UNIQUE("subscription_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_send" DROP CONSTRAINT "hub_send_subscription_period_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "hub_send_subscription_period_unique" ON "hub_send" ("subscription_id","period_end") WHERE "test" = 0;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_ND9aMX9CHD2U_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub_report_subscription"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_member" ADD CONSTRAINT "hub_report_subscription_member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_kind_check", ADD CONSTRAINT "hub_report_subscription_scope_kind_check" CHECK ("scope_kind" IN ('space','project','person','members'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_check", ADD CONSTRAINT "hub_report_subscription_scope_check" CHECK (("scope_kind" = 'space' AND "project_name" IS NULL AND "person_user_id" IS NULL)
        OR ("scope_kind" = 'project' AND "project_name" IS NOT NULL AND "person_user_id" IS NULL)
        OR ("scope_kind" = 'person' AND "person_user_id" IS NOT NULL AND "project_name" IS NULL)
        OR ("scope_kind" = 'members' AND "project_name" IS NULL));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_select" ON "hub_report_subscription_member" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_subscription_member"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_insert" ON "hub_report_subscription_member" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_update" ON "hub_report_subscription_member" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_member_space_delete" ON "hub_report_subscription_member" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_subscription_member"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);