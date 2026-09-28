CREATE TABLE outbox_redaction_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id),
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  rules TEXT NOT NULL,
  withheld_paths TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX outbox_redaction_audit_row ON outbox_redaction_audit(outbox_id, id);

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
