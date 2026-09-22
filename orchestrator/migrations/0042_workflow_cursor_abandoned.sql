CREATE TABLE workflow_cursor_new (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  workflow_slug TEXT NOT NULL,
  mode_slug TEXT NOT NULL,
  workflow_key TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL,
  session_id TEXT,
  workflow_version INTEGER NOT NULL,
  catalogue_version INTEGER NOT NULL,
  args TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  step_slug TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','awaiting-ruling','done','abandoned')),
  closed TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  total_steps INTEGER NOT NULL CHECK (total_steps > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project, workflow_slug, mode_slug, workflow_key, instance_id)
);

INSERT INTO workflow_cursor_new
SELECT * FROM workflow_cursor;

DROP TABLE workflow_cursor;

ALTER TABLE workflow_cursor_new RENAME TO workflow_cursor;

CREATE INDEX workflow_cursor_open_session
  ON workflow_cursor(session_id, project, state);
