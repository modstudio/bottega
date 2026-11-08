ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_comment NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_document NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_status_event NO FORCE ROW LEVEL SECURITY;
ALTER TABLE task_flow NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  dependents text;
BEGIN
  SELECT string_agg(kind || ':' || id::text, ', ' ORDER BY kind, id)
  INTO dependents
  FROM (
    SELECT 'hub_task_comment' AS kind, c.id
    FROM hub_task_comment c JOIN hub_task t ON t.id=c.task_id WHERE t.source='git'
    UNION ALL
    SELECT 'hub_task_document', d.id
    FROM hub_task_document d JOIN hub_task t ON t.id=d.task_id WHERE t.source='git'
    UNION ALL
    SELECT 'hub_task_status_event', e.id
    FROM hub_task_status_event e JOIN hub_task t ON t.id=e.task_id WHERE t.source='git'
    UNION ALL
    SELECT 'task_flow', f.id
    FROM task_flow f JOIN hub_task t ON t.id=f.task_id WHERE t.source='git'
  ) child;
  IF dependents IS NOT NULL THEN
    RAISE EXCEPTION 'git task rows have dependent data: %; preserve or reassign these rows before applying record migrations', dependents;
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM hub_task WHERE source='git';
--> statement-breakpoint
ALTER TABLE task_flow FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_status_event FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_document FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task_comment FORCE ROW LEVEL SECURITY;
ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
