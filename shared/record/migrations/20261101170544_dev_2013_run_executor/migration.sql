ALTER TABLE "run" ADD COLUMN "executor" text;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_executor_check" CHECK ("executor" IS NULL OR "executor" IN ('external', 'harness'));