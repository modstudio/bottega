CREATE TABLE workflow_text_copy (
  record_id TEXT PRIMARY KEY,
  workflow_text_record_id TEXT NOT NULL UNIQUE,
  cursor_record_id TEXT NOT NULL REFERENCES workflow_cursor(record_id),
  task_document_reference TEXT NOT NULL,
  copied_at TEXT NOT NULL
);

CREATE INDEX workflow_text_copy_cursor_idx ON workflow_text_copy(cursor_record_id);
