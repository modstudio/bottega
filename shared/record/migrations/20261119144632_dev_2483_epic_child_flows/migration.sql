ALTER TABLE "task_flow" ADD COLUMN "parent_flow_record_id" uuid;--> statement-breakpoint
CREATE INDEX "task_flow_parent_flow_record_id_idx" ON "task_flow" ("parent_flow_record_id");--> statement-breakpoint
ALTER TABLE "task_flow" ADD CONSTRAINT "task_flow_parent_flow_record_id_fkey" FOREIGN KEY ("parent_flow_record_id") REFERENCES "task_flow"("id");--> statement-breakpoint
ALTER TABLE "board_claim" DROP CONSTRAINT "board_claim_subject_kind_check", ADD CONSTRAINT "board_claim_subject_kind_check" CHECK ("subject_kind" IN ('task','path','resource','queued-task'));--> statement-breakpoint
ALTER TABLE "board_claim" DROP CONSTRAINT "board_claim_close_reason_check", ADD CONSTRAINT "board_claim_close_reason_check" CHECK ("close_reason" IS NULL OR "close_reason" IN
          ('released','lapsed','run-ended','task-closed','taken-over','started'));