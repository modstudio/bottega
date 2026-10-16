UPDATE run SET project_id=(SELECT id FROM project WHERE name=run.repo)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=run.repo)=1;
UPDATE canon_pack SET project_id=(SELECT id FROM project WHERE name=canon_pack.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=canon_pack.project)=1;
UPDATE landing SET project_id=(SELECT id FROM project WHERE name=landing.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing.project)=1;
UPDATE landing_override SET project_id=(SELECT id FROM project WHERE name=landing_override.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_override.project)=1;
UPDATE landing_review_carry SET project_id=(SELECT id FROM project WHERE name=landing_review_carry.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_review_carry.project)=1;
UPDATE landing_triage_snapshot SET project_id=(SELECT id FROM project WHERE name=landing_triage_snapshot.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=landing_triage_snapshot.project)=1;
UPDATE review_read SET project_id=(SELECT id FROM project WHERE name=review_read.project)
WHERE project_id IS NULL AND (SELECT COUNT(*) FROM project WHERE name=review_read.project)=1;
UPDATE doc SET project_id=(SELECT id FROM project WHERE name=doc.subject)
WHERE project_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc.subject)=1;
UPDATE doc_revision SET project_id=(SELECT id FROM project WHERE name=doc_revision.subject)
WHERE project_id IS NULL AND scope IN ('project','resume','canon','settings')
  AND (SELECT COUNT(*) FROM project WHERE name=doc_revision.subject)=1;
--> statement-breakpoint
CREATE TABLE project_identity_contract (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  stack TEXT,
  canon INTEGER NOT NULL DEFAULT 1,
  settings TEXT,
  retired_at TEXT,
  record_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER project_identity_contract_refusal
BEFORE INSERT ON project_identity_contract
WHEN NEW.record_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project identities are incomplete; cleared by: bottega project fill-record-ids');
END;
--> statement-breakpoint
INSERT INTO project_identity_contract (id,name,path,stack,canon,settings,retired_at,record_id)
SELECT id,name,path,stack,canon,settings,retired_at,record_id FROM project ORDER BY id;
--> statement-breakpoint
DROP TRIGGER project_identity_contract_refusal;
DROP TABLE project;
ALTER TABLE project_identity_contract RENAME TO project;
--> statement-breakpoint
CREATE TABLE board_hosted_adoption_ledger_identity (
  source_record_id TEXT PRIMARY KEY,
  local_kind TEXT NOT NULL CHECK (local_kind IN ('notice','question','reply','claim')),
  state TEXT NOT NULL CHECK (state IN ('pending','uploaded','refused')),
  refusal TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state='refused' AND refusal IS NOT NULL) OR (state<>'refused' AND refusal IS NULL))
);
INSERT INTO board_hosted_adoption_ledger_identity
  (source_record_id,local_kind,state,refusal,created_at,updated_at)
SELECT CASE WHEN old.local_kind='claim' THEN claim.record_id ELSE message.record_id END,
       old.local_kind,old.state,old.refusal,old.created_at,old.updated_at
FROM board_hosted_adoption_ledger old
LEFT JOIN board_claim claim ON old.local_kind='claim' AND claim.id=old.local_id
LEFT JOIN board_message message ON old.local_kind<>'claim' AND message.id=old.local_id
WHERE CASE WHEN old.local_kind='claim' THEN claim.record_id ELSE message.record_id END IS NOT NULL;
DROP TABLE board_hosted_adoption_ledger;
ALTER TABLE board_hosted_adoption_ledger_identity RENAME TO board_hosted_adoption_ledger;
--> statement-breakpoint
CREATE TABLE board_hosted_adoption_receipt_identity (
  message_record_id TEXT NOT NULL,
  reader_session TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploaded','skipped')),
  refusal TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_record_id,reader_session),
  CHECK ((state='skipped' AND refusal IS NOT NULL) OR (state='uploaded' AND refusal IS NULL))
);
INSERT INTO board_hosted_adoption_receipt_identity
  (message_record_id,reader_session,state,refusal,updated_at)
SELECT message.record_id,old.reader_session,old.state,old.refusal,old.updated_at
FROM board_hosted_adoption_receipt old
JOIN board_message message ON message.id=old.local_message_id;
DROP TABLE board_hosted_adoption_receipt;
ALTER TABLE board_hosted_adoption_receipt_identity RENAME TO board_hosted_adoption_receipt;
