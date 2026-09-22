ALTER TABLE "run" ADD COLUMN "task_key" text;--> statement-breakpoint
CREATE INDEX "run_space_started_id_idx" ON "run" ("space_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);