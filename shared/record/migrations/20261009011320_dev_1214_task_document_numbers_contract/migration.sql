CREATE UNIQUE INDEX "hub_task_document_task_number_unique" ON "hub_task_document" ("task_id","number");--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD CONSTRAINT "hub_task_document_live_number_check" CHECK ("deleted_at" IS NOT NULL OR "number" IS NOT NULL);
