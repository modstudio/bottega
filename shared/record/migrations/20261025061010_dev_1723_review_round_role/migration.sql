ALTER TABLE "run" ADD COLUMN "review_role" text;--> statement-breakpoint
ALTER TABLE "review" ADD COLUMN "role" text DEFAULT 'round' NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_review_role_check" CHECK ("review_role" IS NULL OR "review_role" IN ('round', 'supplementary'));--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_role_check" CHECK ("role" IN ('round', 'supplementary'));