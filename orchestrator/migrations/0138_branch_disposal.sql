CREATE TABLE branch_disposal (
  record_id TEXT PRIMARY KEY NOT NULL,
  project_record_id TEXT NOT NULL REFERENCES project(record_id),
  branch TEXT NOT NULL,
  tip TEXT NOT NULL,
  task_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('abandoned','superseded','throwaway')),
  note TEXT NOT NULL,
  archive_ref TEXT NOT NULL,
  archive_expires_at TEXT NOT NULL,
  actor_session TEXT NOT NULL,
  disposed_at TEXT NOT NULL,
  UNIQUE(project_record_id, branch, tip)
);
--> statement-breakpoint
CREATE INDEX branch_disposal_expiry ON branch_disposal(archive_expires_at);
