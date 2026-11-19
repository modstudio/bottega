ALTER TABLE task_flow
  ADD COLUMN parent_flow_record_id TEXT REFERENCES task_flow(record_id);
CREATE INDEX task_flow_parent_flow ON task_flow(parent_flow_record_id);
--> statement-breakpoint
PRAGMA legacy_alter_table=ON;
ALTER TABLE board_claim RENAME TO board_claim_dev_2483_old;
CREATE TABLE board_claim (
  record_id TEXT NOT NULL PRIMARY KEY, project TEXT NOT NULL,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task','path','resource','queued-task')),
  subject_value TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('operator','architect')), holder_session TEXT, note TEXT,
  run_record_id TEXT REFERENCES run(record_id), duration_ms INTEGER NOT NULL, taken_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL, lapses_at TEXT NOT NULL, closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('released','lapsed','run-ended','task-closed','taken-over','started')),
  superseded_by_claim_record_id TEXT REFERENCES board_claim(record_id),
  CHECK ((holder_kind='operator' AND holder_session IS NULL) OR (holder_kind='architect' AND holder_session IS NOT NULL)),
  CHECK ((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
INSERT INTO board_claim SELECT * FROM board_claim_dev_2483_old;
DROP TABLE board_claim_dev_2483_old;
CREATE INDEX board_claim_project_subject ON board_claim(project_record_id,subject_kind,subject_value,closed_at);
CREATE INDEX board_claim_run ON board_claim(run_record_id,closed_at);
CREATE INDEX board_claim_superseded ON board_claim(superseded_by_claim_record_id);
CREATE INDEX board_claim_project_record_id ON board_claim(project_record_id);
PRAGMA legacy_alter_table=OFF;
