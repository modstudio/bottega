PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE interval ADD COLUMN record_id TEXT;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE interval
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE interval_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  task_key TEXT,
  project TEXT,
  source TEXT NOT NULL CHECK (source IN ('claude','codex','orch')),
  agent TEXT,
  job TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  claude_tokens INTEGER NOT NULL DEFAULT 0,
  vendor_tokens INTEGER NOT NULL DEFAULT 0,
  vendor_cost_usd REAL,
  ref TEXT NOT NULL,
  via TEXT,
  open INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  user_id TEXT,
  CHECK (end_at >= start_at)
);
--> statement-breakpoint
INSERT INTO interval_uuid
  (record_id,task_key,project,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
   vendor_cost_usd,ref,via,open,session_id,user_id)
SELECT record_id,task_key,project,source,agent,job,start_at,end_at,claude_tokens,vendor_tokens,
  vendor_cost_usd,ref,via,open,session_id,user_id
FROM interval;
--> statement-breakpoint
DROP TABLE interval;
--> statement-breakpoint
ALTER TABLE interval_uuid RENAME TO interval;
--> statement-breakpoint
CREATE UNIQUE INDEX interval_once ON interval(source, ref, start_at);
CREATE INDEX interval_span ON interval(start_at, end_at);
CREATE INDEX interval_task ON interval(task_key, start_at);
--> statement-breakpoint
UPDATE record_ledger
SET local_key = (
  SELECT i.record_id FROM interval i
  WHERE i.source = json_extract(record_ledger.local_key, '$[0]')
    AND i.ref = json_extract(record_ledger.local_key, '$[1]')
    AND i.start_at = json_extract(record_ledger.local_key, '$[2]')
)
WHERE table_name = 'interval'
  AND EXISTS (
    SELECT 1 FROM interval i
    WHERE i.source = json_extract(record_ledger.local_key, '$[0]')
      AND i.ref = json_extract(record_ledger.local_key, '$[1]')
      AND i.start_at = json_extract(record_ledger.local_key, '$[2]')
  );
