PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE pull_request_ci_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  project TEXT NOT NULL,
  project_record_id TEXT NOT NULL REFERENCES project(record_id),
  pr_number INTEGER NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('collection','attempt')),
  complete INTEGER,
  error TEXT,
  workflow_run_id TEXT,
  run_attempt INTEGER,
  workflow_name TEXT,
  event TEXT,
  head_commit TEXT,
  conclusion TEXT,
  failed_jobs TEXT,
  workflow_created_at TEXT,
  workflow_completed_at TEXT,
  recorded_at TEXT NOT NULL,
  CHECK((record_kind='collection' AND complete IS NOT NULL AND workflow_run_id IS NULL AND run_attempt IS NULL)
     OR (record_kind='attempt' AND complete IS NULL AND workflow_run_id IS NOT NULL AND run_attempt IS NOT NULL)),
  UNIQUE(project_record_id, pr_number, record_kind, workflow_run_id, run_attempt)
);
-- Repair rows minted before pull_request_ci.record_id was required.
INSERT INTO pull_request_ci_uuid_key
SELECT COALESCE(
         record_id,
         lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
         substr(lower(hex(randomblob(2))), 2) || '-' ||
         substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
         lower(hex(randomblob(6)))
       ),
       project,project_record_id,pr_number,record_kind,complete,error,workflow_run_id,run_attempt,
       workflow_name,event,head_commit,conclusion,failed_jobs,workflow_created_at,
       workflow_completed_at,recorded_at
FROM pull_request_ci ORDER BY rowid;
DROP TABLE pull_request_ci;
ALTER TABLE pull_request_ci_uuid_key RENAME TO pull_request_ci;
CREATE UNIQUE INDEX pull_request_ci_collection_unique
  ON pull_request_ci(project_record_id,pr_number) WHERE record_kind='collection';
CREATE INDEX pull_request_ci_pr ON pull_request_ci(project_record_id,pr_number);
--> statement-breakpoint
CREATE TABLE compared_pair_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_a_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  run_b_record_id TEXT NOT NULL REFERENCES run(record_id) ON DELETE CASCADE,
  compared_at TEXT NOT NULL,
  UNIQUE(run_a_record_id,run_b_record_id),
  CHECK (run_a_record_id < run_b_record_id)
);
INSERT INTO compared_pair_uuid_key(record_id,run_a_record_id,run_b_record_id,compared_at)
SELECT record_id,run_a_record_id,run_b_record_id,compared_at FROM compared_pair ORDER BY rowid;
DROP TABLE compared_pair;
ALTER TABLE compared_pair_uuid_key RENAME TO compared_pair;
CREATE INDEX compared_pair_run_b_record_id ON compared_pair(run_b_record_id);
--> statement-breakpoint
CREATE TABLE doc_related_subject_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  doc_record_id TEXT NOT NULL REFERENCES doc(record_id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES subject(id) ON DELETE RESTRICT,
  UNIQUE(doc_record_id,subject_id)
);
INSERT INTO doc_related_subject_uuid_key(record_id,doc_record_id,subject_id)
SELECT record_id,doc_record_id,subject_id FROM doc_related_subject ORDER BY rowid;
DROP TABLE doc_related_subject;
ALTER TABLE doc_related_subject_uuid_key RENAME TO doc_related_subject;
CREATE INDEX doc_related_subject_doc ON doc_related_subject(doc_record_id);
CREATE INDEX doc_related_subject_subject ON doc_related_subject(subject_id);
--> statement-breakpoint
CREATE TABLE run_mutation_audit_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  run_record_id TEXT NOT NULL REFERENCES run(record_id),
  root_run_record_id TEXT NOT NULL REFERENCES run(record_id),
  action TEXT NOT NULL CHECK (action IN ('adopt','answer','overturn','file','tell','relay','stop','abandon','discard','sweep','reap','void','unvoid','score','rescore','retry','continue','reclassify','canon-eval')),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
  at TEXT NOT NULL,
  reason TEXT,
  turn_run_record_id TEXT REFERENCES run(record_id)
);
INSERT INTO run_mutation_audit_uuid_key
  (record_id,run_record_id,root_run_record_id,action,actor_session,at,reason,turn_run_record_id)
SELECT record_id,run_record_id,root_run_record_id,action,actor_session,at,reason,turn_run_record_id
FROM run_mutation_audit ORDER BY rowid;
DROP TABLE run_mutation_audit;
ALTER TABLE run_mutation_audit_uuid_key RENAME TO run_mutation_audit;
CREATE INDEX run_mutation_audit_run_record_id ON run_mutation_audit(run_record_id);
CREATE INDEX run_mutation_audit_root ON run_mutation_audit(root_run_record_id);
CREATE INDEX run_mutation_audit_turn ON run_mutation_audit(turn_run_record_id);
