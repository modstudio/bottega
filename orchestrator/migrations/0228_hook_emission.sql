CREATE TABLE hook_emission (
  record_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  hook TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('additionalContext','systemMessage','blockReason','denyReason','allowReason','askReason')),
  chars INTEGER NOT NULL CHECK (chars >= 0),
  lines INTEGER NOT NULL CHECK (lines >= 0),
  text_hash TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX hook_emission_session_at_idx ON hook_emission(session_id,at);
