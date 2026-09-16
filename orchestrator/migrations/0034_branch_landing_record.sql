CREATE TABLE branch_landing_record (
  branch            TEXT PRIMARY KEY,
  pr_number         INTEGER NOT NULL CHECK (pr_number > 0),
  merge_commit      TEXT,
  merged_at         TEXT NOT NULL,
  recording_session TEXT,
  recorded_at       TEXT NOT NULL
);
--> statement-breakpoint
