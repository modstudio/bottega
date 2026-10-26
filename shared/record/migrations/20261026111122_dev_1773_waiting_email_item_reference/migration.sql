ALTER TABLE "operator_waiting_email" DROP CONSTRAINT "operator_waiting_email_episode_unique";--> statement-breakpoint
ALTER TABLE "operator_waiting_email" ADD COLUMN "item_record_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_waiting_email_record_episode_unique" ON "operator_waiting_email" ("space_id","user_id","kind","item_record_id","episode") WHERE "item_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_waiting_email_label_episode_unique" ON "operator_waiting_email" ("space_id","user_id","kind","item_id","episode") WHERE "item_record_id" IS NULL;