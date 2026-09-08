ALTER TABLE run ADD COLUMN minted_branch TEXT;
--> statement-breakpoint
ALTER TABLE run ADD COLUMN unreconciled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE landing_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  project_id INTEGER REFERENCES project(id) ON DELETE RESTRICT,
  branch TEXT NOT NULL,
  tip TEXT,
  trunk_before TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','landed','refused','install_failed','rebase_required'
  )),
  error TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  path_set TEXT CHECK (path_set IS NULL OR json_valid(path_set)),
  requested_at TEXT,
  steps TEXT CHECK (steps IS NULL OR json_valid(steps)),
  causing_landing_id INTEGER,
  claim_pid INTEGER,
  claim_session TEXT
);
--> statement-breakpoint
INSERT INTO landing_new (
  id, project, project_id, branch, tip, trunk_before, status, error,
  session_id, started_at, finished_at, path_set, requested_at, steps, causing_landing_id,
  claim_pid, claim_session
)
SELECT
  id, project, project_id, branch, tip, trunk_before,
  CASE status WHEN 'started' THEN 'running' ELSE status END,
  error, session_id, started_at, finished_at, NULL, started_at, NULL, NULL, NULL, NULL
FROM landing;
--> statement-breakpoint
DROP TABLE landing;
--> statement-breakpoint
ALTER TABLE landing_new RENAME TO landing;
--> statement-breakpoint
CREATE INDEX landing_project_started ON landing(project, started_at);
--> statement-breakpoint
CREATE INDEX landing_project_id ON landing(project_id);
--> statement-breakpoint
CREATE INDEX landing_project_status ON landing(project, status);
--> statement-breakpoint
-- BACKFILL
UPDATE run SET minted_branch = branch
 WHERE minted_branch IS NULL
   AND job IN ('implement','fix','land','issue-worker')
   AND branch IS NOT NULL AND length(trim(branch)) > 0;
-- /BACKFILL
