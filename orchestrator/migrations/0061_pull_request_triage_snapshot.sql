CREATE TABLE landing_triage_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id     TEXT NOT NULL UNIQUE,
  project       TEXT NOT NULL,
  project_id    INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  branch        TEXT NOT NULL,
  tip           TEXT NOT NULL,
  tree          TEXT NOT NULL,
  pr_number     INTEGER CHECK (pr_number > 0),
  review_ids    TEXT NOT NULL CHECK (json_valid(review_ids)),
  patch_id      TEXT NOT NULL,
  tier          INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  lens_rounds   INTEGER NOT NULL CHECK (lens_rounds >= 0),
  finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  override_id   INTEGER REFERENCES landing_override(id),
  session_id    TEXT,
  at            TEXT NOT NULL,
  UNIQUE (project, branch, tip)
);
--> statement-breakpoint
CREATE INDEX landing_triage_snapshot_project_id ON landing_triage_snapshot(project_id);
--> statement-breakpoint
CREATE INDEX landing_triage_snapshot_pr ON landing_triage_snapshot(project, pr_number);
