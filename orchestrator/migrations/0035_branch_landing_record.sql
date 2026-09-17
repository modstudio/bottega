CREATE TABLE branch_landing_record (
  project           TEXT NOT NULL,
  branch            TEXT NOT NULL,
  tip               TEXT NOT NULL,
  pr_number         INTEGER NOT NULL CHECK (pr_number > 0),
  merge_commit      TEXT,
  merged_at         TEXT NOT NULL,
  recording_session TEXT,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (project, branch)
);
--> statement-breakpoint
