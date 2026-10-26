ALTER TABLE "operator_waiting_email" DROP CONSTRAINT "operator_waiting_email_episode_unique";--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD COLUMN "item_record_id" uuid;--> statement-breakpoint
CREATE INDEX "run_unlinked_task_key_idx" ON "run" ("space_id","task_key") WHERE "task_id" IS NULL AND "task_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "question_unlinked_workflow_key_idx" ON "question" ("space_id","workflow_key") WHERE "workflow_task_id" IS NULL AND "workflow_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_waiting_email_record_episode_unique" ON "operator_waiting_email" ("space_id","user_id","kind","item_record_id","episode") WHERE "item_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_waiting_email_label_episode_unique" ON "operator_waiting_email" ("space_id","user_id","kind","item_id","episode") WHERE "item_record_id" IS NULL;--> statement-breakpoint
CREATE INDEX "operator_waiting_email_unlinked_task_key_idx" ON "operator_waiting_email" ("space_id","task_key") WHERE "task_id" IS NULL AND "task_key" IS NOT NULL;