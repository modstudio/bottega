ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_scope_kind_check" CHECK ("scope_kind" IN ('space','project','person'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_scope_check" CHECK (("scope_kind" = 'space' AND "project_name" IS NULL AND "person_user_id" IS NULL)
        OR ("scope_kind" = 'project' AND "project_name" IS NOT NULL AND "person_user_id" IS NULL)
        OR ("scope_kind" = 'person' AND "person_user_id" IS NOT NULL AND "project_name" IS NULL));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_cadence_check" CHECK ("cadence" IN ('daily','weekly'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_hour_check" CHECK ("hour" >= 0 AND "hour" <= 23);--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_weekday_check" CHECK (("cadence" = 'daily' AND "weekday" IS NULL)
        OR ("cadence" = 'weekly' AND "weekday" IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_zone_check" CHECK (char_length("zone") > 0);--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_enabled_check" CHECK ("enabled" IN (0,1));