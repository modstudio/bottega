PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
CREATE TEMP TABLE outbox_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='outbox'),0) seq;
CREATE TEMP TABLE outbox_quarantine_audit_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='outbox_quarantine_audit'),0) seq;
CREATE TEMP TABLE outbox_redaction_audit_sequence_before_record_identity AS
SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='outbox_redaction_audit'),0) seq;
CREATE TEMP TABLE outbox_before_record_identity AS SELECT * FROM outbox;
CREATE TEMP TABLE outbox_quarantine_audit_before_record_identity AS SELECT * FROM outbox_quarantine_audit;
CREATE TEMP TABLE outbox_redaction_audit_before_record_identity AS SELECT * FROM outbox_redaction_audit;
--> statement-breakpoint
DROP TRIGGER outbox_quarantine_audit_no_update;
DROP TRIGGER outbox_quarantine_audit_no_delete;
DROP TRIGGER outbox_redaction_audit_no_update;
DROP TRIGGER outbox_redaction_audit_no_delete;
DROP TABLE outbox_quarantine_audit;
DROP TABLE outbox_redaction_audit;
DROP TABLE outbox;
--> statement-breakpoint
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  row_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  synced_at TEXT,
  quarantined_at TEXT,
  quarantine_reason TEXT,
  retired_at TEXT,
  retirement_reason TEXT,
  record_id TEXT NOT NULL
);
INSERT INTO outbox
  (id,kind,row_id,payload,created_at,attempts,last_error,synced_at,quarantined_at,
   quarantine_reason,retired_at,retirement_reason,record_id)
SELECT id,kind,record_id,payload,created_at,attempts,last_error,synced_at,quarantined_at,
       quarantine_reason,retired_at,retirement_reason,
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
  FROM outbox_before_record_identity ORDER BY id;
CREATE INDEX outbox_synced_at ON outbox(synced_at);
CREATE INDEX outbox_quarantined_at ON outbox(quarantined_at);
CREATE INDEX outbox_latest_synced_row
  ON outbox(kind, row_id, id DESC) WHERE synced_at IS NOT NULL;
CREATE INDEX outbox_row_history ON outbox(kind, row_id, id);
CREATE UNIQUE INDEX outbox_record_id_unique ON outbox(record_id);
--> statement-breakpoint
CREATE TABLE outbox_quarantine_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id),
  kind TEXT NOT NULL,
  row_id TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('quarantine','retry','retire')),
  actor_session TEXT,
  at TEXT NOT NULL,
  reason TEXT,
  record_id TEXT NOT NULL
);
INSERT INTO outbox_quarantine_audit
  (id,outbox_id,kind,row_id,error,attempts,disposition,actor_session,at,reason,record_id)
SELECT id,outbox_id,kind,record_id,error,attempts,disposition,actor_session,at,reason,
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
  FROM outbox_quarantine_audit_before_record_identity ORDER BY id;
CREATE INDEX outbox_quarantine_audit_row ON outbox_quarantine_audit(outbox_id, id);
CREATE UNIQUE INDEX outbox_quarantine_audit_record_id_unique ON outbox_quarantine_audit(record_id);
CREATE TRIGGER outbox_quarantine_audit_no_update
BEFORE UPDATE ON outbox_quarantine_audit
BEGIN
  SELECT RAISE(ABORT, 'outbox quarantine audit is append-only');
END;
CREATE TRIGGER outbox_quarantine_audit_no_delete
BEFORE DELETE ON outbox_quarantine_audit
BEGIN
  SELECT RAISE(ABORT, 'outbox quarantine audit is append-only');
END;
--> statement-breakpoint
CREATE TABLE outbox_redaction_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id),
  kind TEXT NOT NULL,
  row_id TEXT NOT NULL,
  rules TEXT NOT NULL,
  withheld_paths TEXT NOT NULL,
  actor_session TEXT,
  at TEXT NOT NULL,
  record_id TEXT NOT NULL
);
INSERT INTO outbox_redaction_audit
  (id,outbox_id,kind,row_id,rules,withheld_paths,actor_session,at,record_id)
SELECT id,outbox_id,kind,record_id,rules,withheld_paths,actor_session,at,
       lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
  FROM outbox_redaction_audit_before_record_identity ORDER BY id;
CREATE INDEX outbox_redaction_audit_row ON outbox_redaction_audit(outbox_id, id);
CREATE UNIQUE INDEX outbox_redaction_audit_record_id_unique ON outbox_redaction_audit(record_id);
CREATE TRIGGER outbox_redaction_audit_no_update
BEFORE UPDATE ON outbox_redaction_audit
BEGIN
  SELECT RAISE(ABORT, 'outbox redaction audit is append-only');
END;
CREATE TRIGGER outbox_redaction_audit_no_delete
BEFORE DELETE ON outbox_redaction_audit
BEGIN
  SELECT RAISE(ABORT, 'outbox redaction audit is append-only');
END;
--> statement-breakpoint
DELETE FROM sqlite_sequence WHERE name IN ('outbox','outbox_quarantine_audit','outbox_redaction_audit');
INSERT INTO sqlite_sequence(name,seq) SELECT 'outbox',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM outbox),0)) FROM outbox_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'outbox_quarantine_audit',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM outbox_quarantine_audit),0)) FROM outbox_quarantine_audit_sequence_before_record_identity saved;
INSERT INTO sqlite_sequence(name,seq) SELECT 'outbox_redaction_audit',MAX(saved.seq,COALESCE((SELECT MAX(id) FROM outbox_redaction_audit),0)) FROM outbox_redaction_audit_sequence_before_record_identity saved;
--> statement-breakpoint
DROP TABLE outbox_before_record_identity;
DROP TABLE outbox_quarantine_audit_before_record_identity;
DROP TABLE outbox_redaction_audit_before_record_identity;
DROP TABLE outbox_sequence_before_record_identity;
DROP TABLE outbox_quarantine_audit_sequence_before_record_identity;
DROP TABLE outbox_redaction_audit_sequence_before_record_identity;
