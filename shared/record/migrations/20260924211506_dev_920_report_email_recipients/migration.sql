ALTER TABLE "hub_report_subscription_recipient" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD COLUMN "unsubscribe_token" text;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_send_recipient" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_email_unique" UNIQUE("subscription_id","email");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_unsubscribe_token_unique" UNIQUE("unsubscribe_token");--> statement-breakpoint
ALTER TABLE "hub_report_subscription_recipient" ADD CONSTRAINT "hub_report_subscription_recipient_kind_check" CHECK (("user_id" IS NOT NULL AND "email" IS NULL AND "unsubscribe_token" IS NULL)
        OR ("user_id" IS NULL AND "email" IS NOT NULL AND "unsubscribe_token" IS NOT NULL));