CREATE TABLE contention_day (
  record_id TEXT NOT NULL PRIMARY KEY,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  session_id TEXT,
  resource_kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0)
);
CREATE UNIQUE INDEX contention_day_grain
  ON contention_day(day,COALESCE(session_id,''),resource_kind,resource_key,event_kind);
CREATE INDEX contention_day_day ON contention_day(day);
CREATE INDEX contention_at ON contention(at);
--> statement-breakpoint
CREATE TABLE monitor_issue (
  record_id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  UNIQUE(kind,subject)
);
-- BACKFILL
INSERT OR IGNORE INTO monitor_issue(record_id,kind,subject,issue_key,filed_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
       condition.kind,condition.subject,condition.issue_key,invocation.started_at
FROM monitor_condition condition
JOIN monitor_invocation invocation ON invocation.record_id=condition.invocation_record_id
WHERE condition.issue_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM monitor_condition newer
    JOIN monitor_invocation newer_invocation
      ON newer_invocation.record_id=newer.invocation_record_id
    WHERE newer.kind=condition.kind
      AND newer.subject=condition.subject
      AND newer.issue_key IS NOT NULL
      AND (newer_invocation.started_at>invocation.started_at OR
        (newer_invocation.started_at=invocation.started_at AND newer.record_id>condition.record_id))
  );
-- /BACKFILL
