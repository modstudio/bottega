CREATE TABLE resource_claim (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_run_id INTEGER NOT NULL REFERENCES run(id),
  run_id INTEGER NOT NULL REFERENCES run(id),
  project_id INTEGER REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX resource_claim_one_live_allocation
ON resource_claim(kind, allocation_key) WHERE state='claimed';
