PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TEMP TABLE check_execution_gate_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO check_execution_gate_guard(valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM check_execution check_row
  LEFT JOIN gate_execution gate_row ON gate_row.id=check_row.gate_execution_id
  WHERE gate_row.id IS NULL
) THEN 0 ELSE 1 END;
DROP TABLE check_execution_gate_guard;
--> statement-breakpoint
UPDATE workflow_obligation SET satisfied_evidence=(
  SELECT json_group_array(json_object(
    'flag',json_extract(item.value,'$.flag'),
    'value',CASE
      WHEN json_extract(item.value,'$.flag')='--gate'
       AND json_extract(item.value,'$.value') GLOB '[0-9]*'
       AND json_extract(item.value,'$.value') NOT GLOB '*[^0-9]*'
      THEN COALESCE(
        (SELECT gate_row.record_id FROM gate_execution gate_row
          WHERE gate_row.id=CAST(json_extract(item.value,'$.value') AS INTEGER)),
        json_extract(item.value,'$.value')
      )
      ELSE json_extract(item.value,'$.value')
    END
  )) FROM json_each(workflow_obligation.satisfied_evidence) item
) WHERE satisfied_evidence IS NOT NULL;
--> statement-breakpoint
CREATE TABLE gate_execution_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  run_record_id TEXT REFERENCES run(record_id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  timed_out INTEGER CHECK (timed_out IS NULL OR timed_out IN (0,1)),
  elapsed_ms INTEGER,
  output_tail TEXT,
  output_artifact TEXT,
  cancelled_reason TEXT,
  tooling_paths TEXT NOT NULL DEFAULT '[]',
  resolved_command TEXT,
  head_commit TEXT,
  session_id TEXT,
  cwd TEXT,
  base_refresh_elapsed_ms INTEGER CHECK (base_refresh_elapsed_ms IS NULL OR base_refresh_elapsed_ms >= 0),
  base_refresh_result TEXT
);
INSERT INTO gate_execution_uuid_key(
  record_id,number,run_record_id,requested_at,started_at,finished_at,exit_code,timed_out,
  elapsed_ms,output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command,
  head_commit,session_id,cwd,base_refresh_elapsed_ms,base_refresh_result
)
SELECT record_id,id,run_record_id,requested_at,started_at,finished_at,exit_code,timed_out,
       elapsed_ms,output_tail,output_artifact,cancelled_reason,tooling_paths,resolved_command,
       head_commit,session_id,cwd,base_refresh_elapsed_ms,base_refresh_result
FROM gate_execution ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001705','gate_execution',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='gate_execution'),0),COALESCE(MAX(id),0))
FROM gate_execution;
--> statement-breakpoint
CREATE TABLE check_execution_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  gate_execution_record_id TEXT NOT NULL REFERENCES gate_execution_uuid_key(record_id) ON DELETE CASCADE,
  check_name TEXT NOT NULL,
  category TEXT,
  wall_ms REAL NOT NULL CHECK (wall_ms >= 0),
  cpu_ms REAL CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  exit_code INTEGER NOT NULL,
  remaining_count INTEGER CHECK (remaining_count IS NULL OR remaining_count >= 0)
);
INSERT INTO check_execution_uuid_key(
  record_id,gate_execution_record_id,check_name,category,wall_ms,cpu_ms,exit_code,remaining_count
)
SELECT check_row.record_id,gate_row.record_id,check_row.check_name,check_row.category,
       check_row.wall_ms,check_row.cpu_ms,check_row.exit_code,check_row.remaining_count
FROM check_execution check_row
JOIN gate_execution gate_row ON gate_row.id=check_row.gate_execution_id
ORDER BY check_row.id;
DROP TABLE check_execution;
DROP TABLE gate_execution;
ALTER TABLE gate_execution_uuid_key RENAME TO gate_execution;
ALTER TABLE check_execution_uuid_key RENAME TO check_execution;
CREATE UNIQUE INDEX gate_execution_one_active
  ON gate_execution(run_record_id) WHERE finished_at IS NULL;
CREATE INDEX gate_execution_run ON gate_execution(run_record_id,requested_at,record_id);
CREATE INDEX check_execution_category_newest
  ON check_execution(category,gate_execution_record_id);
CREATE INDEX check_execution_gate_execution_record_id_idx
  ON check_execution(gate_execution_record_id);
CREATE TRIGGER gate_execution_assign_number AFTER INSERT ON gate_execution
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'gate execution number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='gate_execution');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM gate_execution),0))+1
   WHERE entity='gate_execution';
  UPDATE gate_execution
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='gate_execution')
   WHERE record_id=NEW.record_id;
END;
