CREATE TABLE "hub_report_subscription_project" (
	"id" uuid PRIMARY KEY,
	"space_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_space_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_report_subscription_project_unique" UNIQUE("subscription_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "hub_report_subscription_project" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_project" ADD CONSTRAINT "hub_report_subscription_project_space_id_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "space"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_project" ADD CONSTRAINT "hub_report_subscription_project_9zSYv4kuAo6n_fkey" FOREIGN KEY ("subscription_id") REFERENCES "hub_report_subscription"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_project" ADD CONSTRAINT "hub_report_subscription_project_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_kind_check", ADD CONSTRAINT "hub_report_subscription_scope_kind_check" CHECK ("scope_kind" IN ('space','project','members','projects'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_check", ADD CONSTRAINT "hub_report_subscription_scope_check" CHECK (("scope_kind" = 'space' AND "project_name" IS NULL)
        OR ("scope_kind" = 'project' AND "project_name" IS NOT NULL)
        OR ("scope_kind" IN ('members','projects') AND "project_name" IS NULL));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_project_space_select" ON "hub_report_subscription_project" AS PERMISSIVE FOR SELECT TO public USING ("hub_report_subscription_project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid OR "hub_report_subscription_project"."space_id" = ANY(
    string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
  ));--> statement-breakpoint
CREATE POLICY "hub_report_subscription_project_space_insert" ON "hub_report_subscription_project" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("hub_report_subscription_project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_project_space_update" ON "hub_report_subscription_project" AS PERMISSIVE FOR UPDATE TO public USING ("hub_report_subscription_project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid) WITH CHECK ("hub_report_subscription_project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_report_subscription_project_space_delete" ON "hub_report_subscription_project" AS PERMISSIVE FOR DELETE TO public USING ("hub_report_subscription_project"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);