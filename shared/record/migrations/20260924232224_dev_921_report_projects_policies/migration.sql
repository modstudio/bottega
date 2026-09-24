ALTER TABLE "hub_report_subscription_project" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hub_report_subscription_project_owner_delivery_select"
ON "hub_report_subscription_project" AS PERMISSIVE FOR SELECT TO record_owner USING (true);
