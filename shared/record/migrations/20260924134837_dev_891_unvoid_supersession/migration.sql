ALTER TABLE "run_exclusion" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_exclusion" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "run_exclusion" ADD COLUMN "supersede_note" text;