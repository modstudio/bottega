ALTER TABLE "hub_report_setting" ADD CONSTRAINT "hub_report_setting_version_check" CHECK ("version" > 0);--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_status_check" CHECK ("status" IN ('sent','skipped','failed'));--> statement-breakpoint
ALTER TABLE "hub_send" ADD CONSTRAINT "hub_send_test_check" CHECK ("test" IN (0,1));
