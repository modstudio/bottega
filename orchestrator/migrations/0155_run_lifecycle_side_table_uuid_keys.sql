PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE run_message_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('to_worker','from_worker')),
  root_run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  sender_session TEXT,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivery TEXT NOT NULL CHECK (delivery IN ('architect_cli','worker_tool')),
  read_by TEXT
);
INSERT INTO run_message_uuid_key(
  record_id,number,direction,root_run_record_id,run_record_id,sender_session,body,created_at,read_at,delivery,read_by
)
SELECT record_id,id,direction,root_run_record_id,run_record_id,sender_session,body,created_at,read_at,delivery,read_by
FROM run_message ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001693','run_message',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='run_message'),0),COALESCE(MAX(id),0))
FROM run_message;
DROP TABLE run_message;
ALTER TABLE run_message_uuid_key RENAME TO run_message;
CREATE INDEX run_message_root ON run_message(root_run_record_id,created_at,record_id);
CREATE INDEX run_message_run_record_id_idx ON run_message(run_record_id);
CREATE INDEX run_message_unread ON run_message(root_run_record_id,direction,read_at) WHERE read_at IS NULL;
CREATE TRIGGER run_message_assign_number AFTER INSERT ON run_message
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'run message number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='run_message');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM run_message),0))+1
   WHERE entity='run_message';
  UPDATE run_message
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='run_message')
   WHERE record_id=NEW.record_id;
END;
--> statement-breakpoint
CREATE TABLE run_checkpoint_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  checkpoint_no INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  task_pointer TEXT,
  final INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(run_record_id,checkpoint_no)
);
INSERT INTO run_checkpoint_uuid_key(record_id,run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
SELECT record_id,run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at
FROM run_checkpoint ORDER BY id;
DROP TABLE run_checkpoint;
ALTER TABLE run_checkpoint_uuid_key RENAME TO run_checkpoint;
--> statement-breakpoint
CREATE TABLE spawn_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  at TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT,
  event TEXT,
  subagent_type TEXT,
  description TEXT,
  prompt_bytes INTEGER,
  decision TEXT NOT NULL,
  why TEXT NOT NULL
);
INSERT INTO spawn_uuid_key(record_id,at,session_id,cwd,event,subagent_type,description,prompt_bytes,decision,why)
SELECT record_id,at,session_id,cwd,event,subagent_type,description,prompt_bytes,decision,why
FROM spawn ORDER BY id;
DROP TABLE spawn;
ALTER TABLE spawn_uuid_key RENAME TO spawn;
CREATE INDEX spawn_at ON spawn(at);
--> statement-breakpoint
CREATE TABLE worker_note_request_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  number INTEGER UNIQUE,
  run_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000 AND instr(text,char(10))=0 AND instr(text,char(13))=0),
  file TEXT CHECK (file IS NULL OR length(file) BETWEEN 1 AND 1000),
  same_as TEXT CHECK (same_as IS NULL OR length(same_as) BETWEEN 1 AND 1000),
  requested_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','filed','refused')),
  note_record_id TEXT,
  note_label TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_ids)),
  candidate_labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_labels)),
  refusal_class TEXT CHECK (refusal_class IN ('anchor-refused','filing-refused','supervisor-closed')),
  detail TEXT,
  project TEXT,
  project_record_id TEXT REFERENCES project(record_id) ON DELETE RESTRICT,
  CHECK ((status='requested' AND finished_at IS NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NULL) OR
         (status='filed' AND finished_at IS NOT NULL AND note_label IS NOT NULL AND refusal_class IS NULL) OR
         (status='refused' AND finished_at IS NOT NULL AND note_record_id IS NULL AND note_label IS NULL AND refusal_class IS NOT NULL))
);
INSERT INTO worker_note_request_uuid_key(
  record_id,number,run_record_id,text,file,same_as,requested_at,claimed_at,finished_at,status,note_record_id,note_label,
  candidate_ids,candidate_labels,refusal_class,detail,project,project_record_id
)
SELECT record_id,id,run_record_id,text,file,same_as,requested_at,claimed_at,finished_at,status,note_record_id,note_label,
       candidate_ids,candidate_labels,refusal_class,detail,project,project_record_id
FROM worker_note_request ORDER BY id;
INSERT INTO entity_number_counter(record_id,entity,last_number)
SELECT '00000000-0000-4000-8000-000000001694','worker_note_request',
       MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='worker_note_request'),0),COALESCE(MAX(id),0))
FROM worker_note_request;
DROP TABLE worker_note_request;
ALTER TABLE worker_note_request_uuid_key RENAME TO worker_note_request;
CREATE INDEX worker_note_request_pending
  ON worker_note_request(run_record_id,status,claimed_at,requested_at,record_id);
CREATE INDEX worker_note_request_project_record_id ON worker_note_request(project_record_id);
CREATE TRIGGER worker_note_request_assign_number AFTER INSERT ON worker_note_request
WHEN NEW.number IS NULL
BEGIN
  SELECT RAISE(ABORT, 'worker note request number counter is missing')
   WHERE NOT EXISTS (SELECT 1 FROM entity_number_counter WHERE entity='worker_note_request');
  UPDATE entity_number_counter
     SET last_number=MAX(last_number,COALESCE((SELECT MAX(number) FROM worker_note_request),0))+1
   WHERE entity='worker_note_request';
  UPDATE worker_note_request
     SET number=(SELECT last_number FROM entity_number_counter WHERE entity='worker_note_request')
   WHERE record_id=NEW.record_id;
END;
