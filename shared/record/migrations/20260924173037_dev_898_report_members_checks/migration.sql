ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_kind_check", ADD CONSTRAINT "hub_report_subscription_scope_kind_check" CHECK ("scope_kind" IN ('space','project','members'));--> statement-breakpoint
ALTER TABLE "hub_report_subscription" DROP CONSTRAINT "hub_report_subscription_scope_check", ADD CONSTRAINT "hub_report_subscription_scope_check" CHECK (("scope_kind" = 'space' AND "project_name" IS NULL)
        OR ("scope_kind" = 'project' AND "project_name" IS NOT NULL)
        OR ("scope_kind" = 'members' AND "project_name" IS NULL));