UPDATE workflow_obligation SET satisfied_evidence=(
  SELECT json_group_array(json_object(
    'flag',json_extract(item.value,'$.flag'),
    'value',CASE
      WHEN json_extract(item.value,'$.flag')='--artifact'
       AND (
         json_extract(item.value,'$.value') GLOB 'probe:[0-9]*'
         OR json_extract(item.value,'$.value') GLOB 'exec:[0-9]*'
       )
       AND substr(json_extract(item.value,'$.value'),instr(json_extract(item.value,'$.value'),':')+1) NOT GLOB '*[^0-9]*'
      THEN COALESCE(
        substr(json_extract(item.value,'$.value'),1,instr(json_extract(item.value,'$.value'),':')) ||
          (SELECT probe_row.record_id FROM probe probe_row
            WHERE probe_row.id=CAST(substr(json_extract(item.value,'$.value'),instr(json_extract(item.value,'$.value'),':')+1) AS INTEGER)),
        json_extract(item.value,'$.value')
      )
      ELSE json_extract(item.value,'$.value')
    END
  )) FROM json_each(workflow_obligation.satisfied_evidence) item
) WHERE satisfied_evidence IS NOT NULL;
--> statement-breakpoint
CREATE TABLE probe_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  head_commit TEXT,
  exit_code INTEGER NOT NULL,
  output_tail TEXT NOT NULL,
  withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0,1)),
  session_id TEXT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'probe' CHECK (kind IN ('probe','exec')),
  command_withheld INTEGER NOT NULL DEFAULT 0 CHECK (command_withheld IN (0,1)),
  pre_command_head_commit TEXT
);
INSERT INTO probe_uuid_key(
  record_id,number,command,cwd,head_commit,exit_code,output_tail,withheld,session_id,
  created_at,kind,command_withheld,pre_command_head_commit
)
SELECT record_id,id,command,cwd,head_commit,exit_code,output_tail,withheld,session_id,
       created_at,kind,command_withheld,pre_command_head_commit
FROM probe ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001708','probe',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='probe'),0),COALESCE(MAX(id),0))
FROM probe;
--> statement-breakpoint
DROP TABLE probe;
ALTER TABLE probe_uuid_key RENAME TO probe;
CREATE TRIGGER probe_assign_number AFTER INSERT ON probe
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'probe number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='probe');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM probe),0))+1
   WHERE entity='probe';
  UPDATE probe
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='probe')
   WHERE record_id=NEW.record_id;
END;
