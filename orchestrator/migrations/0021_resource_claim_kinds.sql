CREATE TEMP TABLE resource_claim_sequence_before_rebuild AS
SELECT seq FROM sqlite_sequence WHERE name='resource_claim';
--> statement-breakpoint
CREATE TABLE resource_claim_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_run_id INTEGER NOT NULL REFERENCES run(id),
  run_id INTEGER NOT NULL REFERENCES run(id),
  project_id INTEGER REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT
);
--> statement-breakpoint
INSERT INTO resource_claim_new
  (id,root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at,settled_at,settled_detail)
SELECT
  id,root_run_id,run_id,project_id,kind,allocation_key,identity,label,state,claimed_at,settled_at,settled_detail
FROM resource_claim
ORDER BY id;
--> statement-breakpoint
DROP TABLE resource_claim;
--> statement-breakpoint
ALTER TABLE resource_claim_new RENAME TO resource_claim;
--> statement-breakpoint
CREATE UNIQUE INDEX resource_claim_one_live_allocation
ON resource_claim(kind, allocation_key) WHERE state='claimed';
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name='resource_claim';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq)
SELECT 'resource_claim',seq FROM resource_claim_sequence_before_rebuild;
--> statement-breakpoint
DROP TABLE resource_claim_sequence_before_rebuild;
