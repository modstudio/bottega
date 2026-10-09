PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
ALTER TABLE day ADD COLUMN record_id TEXT;
--> statement-breakpoint
-- newRecordId() is the runtime minter; these are migration-only random UUID-v4 values.
UPDATE day
SET record_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6)))
WHERE record_id IS NULL;
--> statement-breakpoint
CREATE TABLE day_uuid (
  record_id TEXT NOT NULL PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  claude_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  tasks INTEGER NOT NULL DEFAULT 0,
  canon_tokens INTEGER NOT NULL DEFAULT 0,
  other_tokens INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  lines_product INTEGER NOT NULL DEFAULT 0,
  lines_test INTEGER NOT NULL DEFAULT 0,
  lines_docs INTEGER NOT NULL DEFAULT 0,
  lines_config INTEGER NOT NULL DEFAULT 0,
  lines_generated INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO day_uuid
  (record_id,day,claude_tokens,cache_read,messages,tasks,canon_tokens,other_tokens,commits,files,
   lines_product,lines_test,lines_docs,lines_config,lines_generated,collected_at)
SELECT record_id,day,claude_tokens,cache_read,messages,tasks,canon_tokens,other_tokens,commits,files,
  lines_product,lines_test,lines_docs,lines_config,lines_generated,collected_at
FROM day;
--> statement-breakpoint
DROP TABLE day;
--> statement-breakpoint
ALTER TABLE day_uuid RENAME TO day;
--> statement-breakpoint
UPDATE record_ledger
SET local_key = (
  SELECT d.record_id FROM day d WHERE d.day = record_ledger.local_key
)
WHERE table_name = 'day'
  AND EXISTS (SELECT 1 FROM day d WHERE d.day = record_ledger.local_key);
