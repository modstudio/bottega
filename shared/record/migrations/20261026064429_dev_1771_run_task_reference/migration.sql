ALTER TABLE "run" ADD COLUMN "task_id" uuid;--> statement-breakpoint
CREATE INDEX "run_task_id_idx" ON "run" ("task_id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id") ON DELETE SET NULL;