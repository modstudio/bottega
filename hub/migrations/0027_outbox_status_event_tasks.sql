-- BACKFILL
INSERT OR IGNORE INTO hosted_outbox
  (id,table_name,row_id,operation,queued_at)
SELECT
  t.record_id,
  'hub_task',
  t.record_id,
  'upsert',
  MIN(o.queued_at)
FROM hosted_outbox o
JOIN task_status_event e ON e.record_id=o.row_id
JOIN task t ON t.record_id=e.task_record_id
WHERE o.table_name='hub_task_status_event'
  AND NOT EXISTS (
    SELECT 1 FROM hosted_outbox task_outbox
    WHERE task_outbox.table_name='hub_task' AND task_outbox.row_id=t.record_id
  )
GROUP BY t.record_id;
-- /BACKFILL
