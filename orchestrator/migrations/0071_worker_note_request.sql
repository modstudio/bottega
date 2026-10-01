CREATE TABLE worker_note_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
  file TEXT CHECK (file IS NULL OR length(file) BETWEEN 1 AND 1000),
  requested_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','filed','refused')),
  note_id INTEGER,
  candidate_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_ids)),
  refusal_class TEXT CHECK (refusal_class IN ('anchor-refused','filing-refused','supervisor-closed')),
  detail TEXT,
  CHECK (
    (status = 'requested' AND finished_at IS NULL AND note_id IS NULL AND refusal_class IS NULL) OR
    (status = 'filed' AND finished_at IS NOT NULL AND note_id IS NOT NULL AND refusal_class IS NULL) OR
    (status = 'refused' AND finished_at IS NOT NULL AND note_id IS NULL AND refusal_class IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX worker_note_request_pending ON worker_note_request(run_id,status,claimed_at,id);
