CREATE TABLE record_install_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bound_at TEXT NOT NULL
);
--> statement-breakpoint
-- BACKFILL
INSERT OR IGNORE INTO record_install_binding (id, bound_at)
SELECT 1, datetime('now')
WHERE EXISTS (SELECT 1 FROM outbox WHERE synced_at IS NOT NULL)
   OR EXISTS (SELECT 1 FROM doc WHERE record_id IS NOT NULL)
   OR EXISTS (SELECT 1 FROM doc_revision WHERE record_id IS NOT NULL)
   OR EXISTS (
     SELECT 1 FROM schema_meta
     WHERE key IN ('record_docs_cursor', 'record_scores_cursor')
   );
-- /BACKFILL
