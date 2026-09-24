ALTER TABLE "hub_note" ADD COLUMN "promoted_task_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "task_id" uuid;--> statement-breakpoint
CREATE INDEX "hub_note_promoted_task_id_idx" ON "hub_note" ("promoted_task_id");--> statement-breakpoint
CREATE INDEX "hub_task_parent_id_idx" ON "hub_task" ("parent_id");--> statement-breakpoint
CREATE INDEX "hub_task_comment_task_id_idx" ON "hub_task_comment" ("task_id");--> statement-breakpoint
CREATE INDEX "hub_task_document_task_id_idx" ON "hub_task_document" ("task_id");--> statement-breakpoint
CREATE INDEX "hub_task_status_event_task_id_idx" ON "hub_task_status_event" ("task_id");--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_promoted_task_id_hub_task_id_fkey" FOREIGN KEY ("promoted_task_id") REFERENCES "hub_task"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task" ADD CONSTRAINT "hub_task_parent_id_hub_task_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "hub_task"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD CONSTRAINT "hub_task_comment_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD CONSTRAINT "hub_task_document_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD CONSTRAINT "hub_task_status_event_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id") ON DELETE CASCADE;