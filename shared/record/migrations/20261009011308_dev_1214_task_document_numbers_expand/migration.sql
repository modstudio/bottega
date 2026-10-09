ALTER TABLE "hub_task" ADD COLUMN "next_document_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD COLUMN "number" integer;