ALTER TABLE outbox ADD COLUMN quarantined_at TEXT;
ALTER TABLE outbox ADD COLUMN quarantine_reason TEXT;
ALTER TABLE outbox ADD COLUMN retired_at TEXT;
ALTER TABLE outbox ADD COLUMN retirement_reason TEXT;

CREATE INDEX outbox_quarantined_at ON outbox(quarantined_at);

CREATE TABLE outbox_quarantine_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER NOT NULL REFERENCES outbox(id),
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('quarantine','retry','retire')),
  actor_session TEXT,
  at TEXT NOT NULL,
  reason TEXT
);

CREATE INDEX outbox_quarantine_audit_row ON outbox_quarantine_audit(outbox_id, id);

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
