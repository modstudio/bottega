ALTER TABLE task ADD COLUMN record_id TEXT;
--> statement-breakpoint
ALTER TABLE task_comment ADD COLUMN record_id TEXT;
--> statement-breakpoint
ALTER TABLE task_document ADD COLUMN record_id TEXT;
--> statement-breakpoint
ALTER TABLE task_status_event ADD COLUMN record_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX task_record_id ON task(record_id) WHERE record_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX task_comment_record_id ON task_comment(record_id) WHERE record_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX task_document_record_id ON task_document(record_id) WHERE record_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX task_status_event_record_id ON task_status_event(record_id) WHERE record_id IS NOT NULL;
