ALTER TABLE question_delivery RENAME TO question_delivery_before_retired;
--> statement-breakpoint
CREATE TABLE question_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'resume', 'retry', 'record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed', 'retired')),
  at TEXT NOT NULL,
  error TEXT
);
--> statement-breakpoint
INSERT INTO question_delivery SELECT * FROM question_delivery_before_retired;
--> statement-breakpoint
DROP TABLE question_delivery_before_retired;
