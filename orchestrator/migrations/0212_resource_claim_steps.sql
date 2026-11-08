CREATE TABLE resource_claim_step (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  root_run_record_id TEXT NOT NULL REFERENCES run(record_id),
  run_record_id TEXT NOT NULL REFERENCES run(record_id),
  project_record_id TEXT REFERENCES project(record_id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','ref_guard','run_lease','port','database','index','string')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','released','retained','forgotten','absent','stuck')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT,
  step_no INTEGER,
  lifetime TEXT NOT NULL DEFAULT 'runtime' CHECK (lifetime IN ('runtime','kept')),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0,1))
);
--> statement-breakpoint
INSERT INTO resource_claim_step(
  record_id,number,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
  identity,label,state,claimed_at,settled_at,settled_detail
)
SELECT record_id,number,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
       identity,label,state,claimed_at,settled_at,settled_detail
FROM resource_claim;
--> statement-breakpoint
DROP TABLE resource_claim;
--> statement-breakpoint
ALTER TABLE resource_claim_step RENAME TO resource_claim;
--> statement-breakpoint
CREATE UNIQUE INDEX resource_claim_one_live_allocation
  ON resource_claim(kind,allocation_key) WHERE state='claimed' AND shared=0;
--> statement-breakpoint
CREATE INDEX resource_claim_run_record_id_idx ON resource_claim(run_record_id);
--> statement-breakpoint
CREATE INDEX resource_claim_root_run_record_id_idx ON resource_claim(root_run_record_id);
--> statement-breakpoint
CREATE INDEX resource_claim_project_record_id_idx ON resource_claim(project_record_id);
--> statement-breakpoint
CREATE INDEX resource_claim_root_step_idx ON resource_claim(root_run_record_id,step_no);
--> statement-breakpoint
CREATE TRIGGER resource_claim_assign_number AFTER INSERT ON resource_claim
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'resource claim number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='resource_claim');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM resource_claim),0))+1
   WHERE entity='resource_claim';
  UPDATE resource_claim
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='resource_claim')
   WHERE record_id=NEW.record_id;
END;
