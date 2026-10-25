CREATE TABLE metric_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  claude_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  tasks INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  canon_tokens INTEGER NOT NULL DEFAULT 0,
  other_tokens INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  lines_product INTEGER NOT NULL DEFAULT 0,
  lines_test INTEGER NOT NULL DEFAULT 0,
  lines_docs INTEGER NOT NULL DEFAULT 0,
  lines_config INTEGER NOT NULL DEFAULT 0,
  lines_generated INTEGER NOT NULL DEFAULT 0
);
INSERT INTO metric_uuid_key(
  record_id,day,claude_tokens,cache_read,messages,tasks,collected_at,canon_tokens,
  other_tokens,commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated
)
SELECT
  record_id,day,claude_tokens,cache_read,messages,tasks,collected_at,canon_tokens,
  other_tokens,commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated
FROM metric ORDER BY day;
DROP TABLE metric;
ALTER TABLE metric_uuid_key RENAME TO metric;
--> statement-breakpoint
CREATE TABLE hosted_board_receipt_cache_uuid_key (
  record_id TEXT NOT NULL PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES hosted_board_message_cache(id) ON DELETE CASCADE,
  reader_session TEXT NOT NULL,
  audience_at_posting INTEGER NOT NULL CHECK (audience_at_posting IN (0,1)),
  delivered_at TEXT,
  acknowledged_at TEXT,
  pending_sync INTEGER NOT NULL DEFAULT 0 CHECK (pending_sync IN (0,1)),
  sync_error TEXT,
  successor INTEGER NOT NULL DEFAULT 0 CHECK (successor IN (0,1)),
  UNIQUE(message_id,reader_session)
);
INSERT INTO hosted_board_receipt_cache_uuid_key(
  record_id,message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,
  pending_sync,sync_error,successor
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,
  pending_sync,sync_error,successor
FROM hosted_board_receipt_cache ORDER BY message_id,reader_session;
DROP TABLE hosted_board_receipt_cache;
ALTER TABLE hosted_board_receipt_cache_uuid_key RENAME TO hosted_board_receipt_cache;
CREATE INDEX hosted_board_receipt_pending ON hosted_board_receipt_cache(pending_sync);
