ALTER TABLE workflow_cursor ADD COLUMN task_record_id TEXT;
ALTER TABLE question ADD COLUMN workflow_task_record_id TEXT;
ALTER TABLE port_ref ADD COLUMN task_record_id TEXT;
ALTER TABLE presence ADD COLUMN current_task_record_id TEXT;
--> statement-breakpoint
CREATE INDEX workflow_cursor_task_record_id ON workflow_cursor(task_record_id);
CREATE INDEX question_workflow_task_record_id ON question(workflow_task_record_id);
CREATE INDEX port_ref_task_record_id ON port_ref(task_record_id);
CREATE INDEX presence_current_task_record_id ON presence(current_task_record_id);
