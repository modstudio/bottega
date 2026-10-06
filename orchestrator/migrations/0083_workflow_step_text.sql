CREATE TABLE workflow_step_text (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cursor_id INTEGER NOT NULL REFERENCES workflow_cursor(id) ON DELETE CASCADE,
  step_ordinal INTEGER NOT NULL,
  step_slug TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX workflow_step_text_cursor_step
  ON workflow_step_text(cursor_id,step_ordinal,id);
