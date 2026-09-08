ALTER TABLE run ADD COLUMN work_preserved INTEGER NOT NULL DEFAULT 0;

CREATE TABLE run_checkpoint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  checkpoint_no INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  task_pointer TEXT,
  final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, checkpoint_no)
);
