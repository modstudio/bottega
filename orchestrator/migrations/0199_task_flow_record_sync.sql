ALTER TABLE task_flow ADD COLUMN opening_machine_id TEXT;
ALTER TABLE task_flow ADD COLUMN updated_machine_id TEXT;
ALTER TABLE task_flow ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_cursor ADD COLUMN opened_machine_id TEXT;
ALTER TABLE workflow_cursor ADD COLUMN taken_over_from_machine_id TEXT;
ALTER TABLE workflow_cursor ADD COLUMN last_advanced_machine_id TEXT;
ALTER TABLE workflow_cursor ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
-- BACKFILL
UPDATE task_flow
SET opening_machine_id=(SELECT value FROM schema_meta WHERE key='machine_id'),
    updated_machine_id=(SELECT value FROM schema_meta WHERE key='machine_id')
WHERE opening_machine_id IS NULL OR updated_machine_id IS NULL;
UPDATE workflow_cursor
SET opened_machine_id=(SELECT value FROM schema_meta WHERE key='machine_id'),
    last_advanced_machine_id=(SELECT value FROM schema_meta WHERE key='machine_id')
WHERE opened_machine_id IS NULL OR last_advanced_machine_id IS NULL;
-- /BACKFILL
