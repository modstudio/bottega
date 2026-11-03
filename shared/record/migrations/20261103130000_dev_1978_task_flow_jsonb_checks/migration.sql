ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_arguments_not_json_string_check" CHECK (jsonb_typeof("arguments") <> 'string') NOT VALID;--> statement-breakpoint
ALTER TABLE "task_flow_stage" ADD CONSTRAINT "task_flow_stage_closed_step_notes_not_json_string_check" CHECK (jsonb_typeof("closed_step_notes") <> 'string') NOT VALID;
