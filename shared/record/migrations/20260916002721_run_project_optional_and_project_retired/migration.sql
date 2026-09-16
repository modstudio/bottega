ALTER TABLE "project" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ALTER COLUMN "project_id" DROP NOT NULL;