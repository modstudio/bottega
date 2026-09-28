ALTER TABLE "run" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "run_score" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "review_finding" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "review_lens" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "review_read" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "contention" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "landing" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "landing_override" ADD COLUMN "withheld_fields" jsonb;--> statement-breakpoint
ALTER TABLE "test_flake" ADD COLUMN "withheld_fields" jsonb;