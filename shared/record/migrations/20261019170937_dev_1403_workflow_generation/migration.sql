ALTER TABLE "step_catalogue" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;