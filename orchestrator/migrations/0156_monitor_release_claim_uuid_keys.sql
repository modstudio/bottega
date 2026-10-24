PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TEMP TABLE monitor_condition_invocation_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO monitor_condition_invocation_guard(valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM monitor_condition condition
  LEFT JOIN monitor_invocation invocation ON invocation.id=condition.invocation_id
  WHERE invocation.id IS NULL
) THEN 0 ELSE 1 END;
DROP TABLE monitor_condition_invocation_guard;
--> statement-breakpoint
CREATE TABLE monitor_invocation_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('invoked','backstop')),
  findings INTEGER,
  errors INTEGER,
  host_load TEXT
);
INSERT INTO monitor_invocation_uuid_key(
  record_id,number,started_at,finished_at,trigger,findings,errors,host_load
)
SELECT record_id,id,started_at,finished_at,trigger,findings,errors,host_load
FROM monitor_invocation ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001701','monitor_invocation',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='monitor_invocation'),0),COALESCE(MAX(id),0))
FROM monitor_invocation;
--> statement-breakpoint
CREATE TABLE monitor_condition_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  invocation_record_id TEXT NOT NULL REFERENCES monitor_invocation_uuid_key(record_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  condition_since TEXT,
  age_ms INTEGER,
  detail TEXT NOT NULL,
  action TEXT NOT NULL,
  issue_key TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('informational','attention')),
  owner_session_id TEXT,
  delivered_at TEXT,
  UNIQUE(invocation_record_id,kind,subject)
);
INSERT INTO monitor_condition_uuid_key(
  record_id,number,invocation_record_id,kind,subject,condition_since,age_ms,detail,action,
  issue_key,severity,owner_session_id,delivered_at
)
SELECT condition.record_id,condition.id,invocation.record_id,condition.kind,condition.subject,
       condition.condition_since,condition.age_ms,condition.detail,condition.action,
       condition.issue_key,condition.severity,condition.owner_session_id,condition.delivered_at
FROM monitor_condition condition
JOIN monitor_invocation invocation ON invocation.id=condition.invocation_id
ORDER BY condition.id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001702','monitor_condition',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='monitor_condition'),0),COALESCE(MAX(id),0))
FROM monitor_condition;
DROP TABLE monitor_condition;
DROP TABLE monitor_invocation;
ALTER TABLE monitor_invocation_uuid_key RENAME TO monitor_invocation;
ALTER TABLE monitor_condition_uuid_key RENAME TO monitor_condition;
CREATE INDEX monitor_condition_kind ON monitor_condition(kind,invocation_record_id);
CREATE INDEX monitor_condition_latest
  ON monitor_condition(owner_session_id,kind,subject,condition_since,invocation_record_id);
CREATE INDEX monitor_condition_owner_delivery ON monitor_condition(owner_session_id,delivered_at);
CREATE INDEX monitor_condition_invocation_record_id_idx ON monitor_condition(invocation_record_id);
CREATE TRIGGER monitor_invocation_assign_number AFTER INSERT ON monitor_invocation
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'monitor invocation number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='monitor_invocation');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM monitor_invocation),0))+1
   WHERE entity='monitor_invocation';
  UPDATE monitor_invocation
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='monitor_invocation')
   WHERE record_id=NEW.record_id;
END;
CREATE TRIGGER monitor_condition_assign_number AFTER INSERT ON monitor_condition
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'monitor condition number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='monitor_condition');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM monitor_condition),0))+1
   WHERE entity='monitor_condition';
  UPDATE monitor_condition
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='monitor_condition')
   WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TABLE release_ledger_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  project TEXT NOT NULL,
  rung TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  live_commit_before TEXT,
  rollback INTEGER NOT NULL CHECK (rollback IN (0,1)),
  rollback_reason TEXT,
  actor TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  output_tail TEXT NOT NULL DEFAULT '',
  live_commit_after TEXT,
  live_matches_candidate INTEGER CHECK (live_matches_candidate IN (0,1)),
  warning TEXT,
  project_record_id TEXT REFERENCES project(record_id),
  trunk TEXT,
  trunk_tip TEXT,
  commits_behind_trunk INTEGER,
  behind_trunk_reason TEXT,
  CHECK ((rollback = 1 AND rollback_reason IS NOT NULL) OR (rollback = 0 AND rollback_reason IS NULL)),
  CHECK ((finished_at IS NULL AND exit_code IS NULL) OR (finished_at IS NOT NULL AND exit_code IS NOT NULL))
);
INSERT INTO release_ledger_uuid_key(
  record_id,number,project,rung,candidate_commit,live_commit_before,rollback,rollback_reason,actor,
  session_id,started_at,finished_at,exit_code,output_tail,live_commit_after,live_matches_candidate,
  warning,project_record_id,trunk,trunk_tip,commits_behind_trunk,behind_trunk_reason
)
SELECT record_id,id,project,rung,candidate_commit,live_commit_before,rollback,rollback_reason,actor,
       session_id,started_at,finished_at,exit_code,output_tail,live_commit_after,live_matches_candidate,
       warning,project_record_id,trunk,trunk_tip,commits_behind_trunk,behind_trunk_reason
FROM release_ledger ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001703','release_ledger',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='release_ledger'),0),COALESCE(MAX(id),0))
FROM release_ledger;
DROP TABLE release_ledger;
ALTER TABLE release_ledger_uuid_key RENAME TO release_ledger;
CREATE INDEX release_ledger_project_rung_started
  ON release_ledger(project,rung,started_at DESC,record_id DESC);
CREATE INDEX release_ledger_project_record_id_idx ON release_ledger(project_record_id);
CREATE TRIGGER release_ledger_assign_number AFTER INSERT ON release_ledger
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'release ledger number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='release_ledger');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM release_ledger),0))+1
   WHERE entity='release_ledger';
  UPDATE release_ledger
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='release_ledger')
   WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TABLE resource_claim_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  root_run_record_id TEXT NOT NULL REFERENCES run(record_id),
  run_record_id TEXT NOT NULL REFERENCES run(record_id),
  project_record_id TEXT REFERENCES project(record_id),
  kind TEXT NOT NULL CHECK (kind IN ('worktree','branch','retained_ref','sandbox_dir','trust_entry','port','database','index','string')),
  allocation_key TEXT NOT NULL,
  identity TEXT,
  label TEXT,
  state TEXT NOT NULL CHECK (state IN ('claimed','released','retained','forgotten','absent')),
  claimed_at TEXT NOT NULL,
  settled_at TEXT,
  settled_detail TEXT
);
INSERT INTO resource_claim_uuid_key(
  record_id,number,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
  identity,label,state,claimed_at,settled_at,settled_detail
)
SELECT record_id,id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,
       identity,label,state,claimed_at,settled_at,settled_detail
FROM resource_claim ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001704','resource_claim',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='resource_claim'),0),COALESCE(MAX(id),0))
FROM resource_claim;
DROP TABLE resource_claim;
ALTER TABLE resource_claim_uuid_key RENAME TO resource_claim;
CREATE UNIQUE INDEX resource_claim_one_live_allocation
  ON resource_claim(kind,allocation_key) WHERE state='claimed';
CREATE INDEX resource_claim_run_record_id_idx ON resource_claim(run_record_id);
CREATE INDEX resource_claim_root_run_record_id_idx ON resource_claim(root_run_record_id);
CREATE INDEX resource_claim_project_record_id_idx ON resource_claim(project_record_id);
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
