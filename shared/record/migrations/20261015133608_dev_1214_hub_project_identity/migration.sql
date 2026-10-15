ALTER TABLE "hub_interval" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_note" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_interval" ADD CONSTRAINT "hub_interval_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_note" ADD CONSTRAINT "hub_note_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_note_acknowledgement" ADD CONSTRAINT "hub_note_acknowledgement_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_report_subscription" ADD CONSTRAINT "hub_report_subscription_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task" ADD CONSTRAINT "hub_task_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_comment" ADD CONSTRAINT "hub_task_comment_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_document" ADD CONSTRAINT "hub_task_document_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hub_task_status_event" ADD CONSTRAINT "hub_task_status_event_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL;
