CREATE TABLE board_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource')),
  subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')),
  holder_session TEXT,
  note TEXT,
  run_id INTEGER REFERENCES run(id),
  duration_ms INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  lapses_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over')),
  superseded_by_claim_id INTEGER REFERENCES board_claim(id),
  CHECK (
    (holder_kind = 'operator' AND holder_session IS NULL) OR
    (holder_kind = 'architect' AND holder_session IS NOT NULL)
  ),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR
         (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);

CREATE INDEX board_claim_project_subject
  ON board_claim(project, subject_kind, subject_value, closed_at);
CREATE INDEX board_claim_run ON board_claim(run_id, closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_id);

ALTER TABLE board_message ADD COLUMN claim_id INTEGER REFERENCES board_claim(id);
