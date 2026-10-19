ALTER TABLE workflow ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE step_catalogue ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
DELETE FROM schema_meta WHERE key GLOB 'record_workflow_cursor:*';
