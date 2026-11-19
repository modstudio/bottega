-- Fenced one-time DDL: a backfill would re-delete these cursors on every migration run.
DELETE FROM schema_meta
 WHERE key LIKE 'record_subjects_cursor:%'
    OR key = 'record_change_cursor';
