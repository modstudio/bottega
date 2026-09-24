ALTER TABLE question ADD COLUMN asked_via TEXT CHECK (asked_via IN ('live', 'reply'));
--> statement-breakpoint
ALTER TABLE question ADD COLUMN answerer_kind TEXT CHECK (answerer_kind IN ('agent', 'operator', 'eval'));
--> statement-breakpoint
ALTER TABLE question ADD COLUMN answer_channel TEXT;
--> statement-breakpoint
CREATE TABLE question_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES question(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES run(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'resume', 'retry', 'record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed')),
  at TEXT NOT NULL,
  error TEXT
);
--> statement-breakpoint
-- BACKFILL
UPDATE question
   SET answerer_kind = CASE
     WHEN answered_by LIKE 'operator via %' THEN 'operator'
     WHEN answered_by = 'canon-eval' THEN 'eval'
     WHEN answered_by IS NOT NULL THEN 'agent'
   END
 WHERE answered_by IS NOT NULL AND answerer_kind IS NULL;
-- /BACKFILL
