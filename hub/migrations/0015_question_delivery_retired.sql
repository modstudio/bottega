ALTER TABLE question_delivery RENAME TO question_delivery_before_retired;
--> statement-breakpoint
CREATE TABLE question_delivery (
  question_id INTEGER NOT NULL REFERENCES question(question_id) ON DELETE CASCADE,
  run_ref TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'resume', 'retry', 'record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'retired')),
  at TEXT NOT NULL,
  error TEXT
);
--> statement-breakpoint
INSERT INTO question_delivery (question_id,run_ref,mode,outcome,at,error)
SELECT question_id,run_ref,mode,outcome,at,error FROM question_delivery_before_retired;
--> statement-breakpoint
DROP TABLE question_delivery_before_retired;
