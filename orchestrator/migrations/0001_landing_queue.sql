ALTER TABLE run ADD COLUMN pre_confinement TEXT;
--> statement-breakpoint
CREATE TABLE landing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  tip TEXT,
  trunk_before TEXT,
  status TEXT NOT NULL CHECK (status IN ('started','landed','refused','install_failed')),
  error TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
--> statement-breakpoint
CREATE INDEX landing_project_started ON landing(project, started_at);
