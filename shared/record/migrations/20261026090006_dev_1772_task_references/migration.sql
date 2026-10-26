ALTER TABLE "question" ADD COLUMN "workflow_task_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD COLUMN "task_id" uuid;--> statement-breakpoint
CREATE INDEX "question_workflow_task_id_idx" ON "question" ("workflow_task_id");--> statement-breakpoint
CREATE INDEX "operator_waiting_email_task_id_idx" ON "operator_waiting_email" ("task_id");--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_workflow_task_id_hub_task_id_fkey" FOREIGN KEY ("workflow_task_id") REFERENCES "hub_task"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD CONSTRAINT "operator_waiting_email_task_id_hub_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "hub_task"("id") ON DELETE SET NULL;