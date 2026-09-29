ALTER TABLE question_mutation_audit RENAME TO question_mutation_audit_before_close;
--> statement-breakpoint
CREATE TABLE question_mutation_audit (
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('rule','overturn','file','close')),
  actor_session TEXT,
  at TEXT NOT NULL,
  reason TEXT
);
--> statement-breakpoint
INSERT INTO question_mutation_audit SELECT * FROM question_mutation_audit_before_close;
--> statement-breakpoint
DROP TABLE question_mutation_audit_before_close;
--> statement-breakpoint
CREATE INDEX question_mutation_audit_question ON question_mutation_audit(question_id,at);
