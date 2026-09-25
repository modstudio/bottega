ALTER TABLE question ADD COLUMN asked_via TEXT CHECK (asked_via IN ('live', 'reply'));
--> statement-breakpoint
ALTER TABLE question ADD COLUMN answerer_kind TEXT CHECK (answerer_kind IN ('agent', 'operator', 'eval'));
--> statement-breakpoint
ALTER TABLE question ADD COLUMN answer_channel TEXT CHECK (answer_channel IN ('cli', 'mcp', 'ui'));
--> statement-breakpoint
CREATE TABLE question_delivery (
  question_id INTEGER NOT NULL REFERENCES question(question_id) ON DELETE CASCADE,
  run_ref TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'resume', 'retry', 'record-only')),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'failed')),
  at TEXT NOT NULL,
  error TEXT
);
-- BACKFILL
-- DEFAULT_STATS_DAYS in hub/src/rulings.ts is 14. SQL cannot import that constant.
UPDATE setting
SET value = CASE
  WHEN julianday(CASE WHEN json_valid(value) THEN json_extract(value, '$') ELSE value END)
       <= julianday('now', '-14 days')
    THEN value
  ELSE json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days'))
END
WHERE key = 'collect.runs.at';
-- /BACKFILL
