CREATE TABLE context_review (
  record_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK (interval_ms >= 0),
  items INTEGER NOT NULL CHECK (items >= 0),
  flagged INTEGER NOT NULL CHECK (flagged >= 0 AND flagged <= items),
  item_ids TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX context_review_session_at_idx ON context_review(session_id,at);
