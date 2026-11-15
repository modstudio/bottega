ALTER TABLE "review" ADD COLUMN "zero_context_patch_id" text;--> statement-breakpoint
ALTER TABLE "review_funnel_decision" ADD COLUMN "zero_context_patch_id" text;--> statement-breakpoint
ALTER TABLE "review_read" ADD COLUMN "zero_context_patch_id" text;--> statement-breakpoint
ALTER TABLE "landing_override" ADD COLUMN "zero_context_patch_id" text;--> statement-breakpoint
ALTER TABLE "landing_review_carry" ADD COLUMN "zero_context_patch_id" text;--> statement-breakpoint
ALTER TABLE "landing_triage_snapshot" ADD COLUMN "zero_context_patch_id" text;