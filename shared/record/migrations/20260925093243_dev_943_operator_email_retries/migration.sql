ALTER TABLE "operator_waiting_email" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD CONSTRAINT "operator_waiting_email_attempts_check" CHECK ("attempts" > 0);--> statement-breakpoint
ALTER TABLE "operator_waiting_email" DROP CONSTRAINT "operator_waiting_email_status_check", ADD CONSTRAINT "operator_waiting_email_status_check" CHECK ("status" IN ('intent','sent','failed','abandoned'));