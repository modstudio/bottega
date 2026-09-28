CREATE TABLE review_read (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id   TEXT NOT NULL UNIQUE,
  project     TEXT NOT NULL,
  project_id  INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  branch      TEXT NOT NULL,
  tip         TEXT NOT NULL,
  patch_id    TEXT NOT NULL,
  path_set    TEXT NOT NULL CHECK (json_valid(path_set)),
  tier        INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  note        TEXT NOT NULL CHECK (length(trim(note)) > 0),
  session_id  TEXT,
  recorded_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX review_read_change_group ON review_read(project, branch, patch_id, path_set);
--> statement-breakpoint
ALTER TABLE landing_triage_snapshot ADD COLUMN admission_path TEXT NOT NULL DEFAULT 'exact_review'
  CHECK (admission_path IN ('exact_review','architect_read'));
--> statement-breakpoint
ALTER TABLE landing_triage_snapshot ADD COLUMN read_id INTEGER REFERENCES review_read(id);
