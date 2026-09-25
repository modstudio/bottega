ALTER TABLE question ADD COLUMN awaiting_operator_at TEXT;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN relayed_by TEXT;
--> statement-breakpoint
ALTER TABLE question ADD COLUMN notified_at TEXT;
--> statement-breakpoint
CREATE TABLE workflow_operator_notification (
  cursor_id   INTEGER PRIMARY KEY REFERENCES workflow_cursor(id) ON DELETE CASCADE,
  notified_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE run_mutation_audit_new (
  run_id       INTEGER NOT NULL REFERENCES run(id),
  root_id      INTEGER NOT NULL REFERENCES run(id),
  action       TEXT NOT NULL CHECK (action IN ('adopt','answer','tell','relay','stop','abandon','discard','sweep','reap','void','unvoid','score','rescore','retry','continue','reclassify','canon-eval')),
  actor_session TEXT CHECK (actor_session IS NULL OR length(actor_session) > 0),
  at           TEXT NOT NULL,
  reason       TEXT
);
--> statement-breakpoint
INSERT INTO run_mutation_audit_new SELECT * FROM run_mutation_audit;
--> statement-breakpoint
DROP TABLE run_mutation_audit;
--> statement-breakpoint
ALTER TABLE run_mutation_audit_new RENAME TO run_mutation_audit;
--> statement-breakpoint
CREATE INDEX run_mutation_audit_root ON run_mutation_audit(root_id);
