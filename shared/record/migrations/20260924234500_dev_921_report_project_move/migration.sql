-- A report selection belongs to its subscription's personal space. Project moves
-- update only its exact current-space reference, leaving ownership and display snapshot intact.
DO $migration$
DECLARE
  definition text;
  direct_candidate text := $fragment$IF candidate.table_name <> 'project' AND (candidate.by_id OR candidate.by_name) THEN$fragment$;
  excluded_direct text := $fragment$IF candidate.table_name NOT IN ('project', 'hub_report_subscription_project') AND (candidate.by_id OR candidate.by_name) THEN$fragment$;
  candidate_fragment text := $fragment$AND c.table_name <> 'hub_send'
        AND NOT EXISTS (SELECT 1 FROM move_plan mp WHERE mp.name=c.table_name)$fragment$;
  excluded_fragment text := $fragment$AND c.table_name NOT IN ('hub_send', 'hub_report_subscription_project')
        AND NOT EXISTS (SELECT 1 FROM move_plan mp WHERE mp.name=c.table_name)$fragment$;
  recipient_reason text := $fragment$WHEN 'hub_send_recipient' THEN 'space send recipient; parent send is not project-attributable'$fragment$;
  selection_reason text := $fragment$WHEN 'hub_send_recipient' THEN 'space send recipient; parent send is not project-attributable'
          WHEN 'hub_report_subscription_project' THEN 'report selection; space reference updated, ownership kept'$fragment$;
  lock_fragment text := $fragment$END LOOP;

  CREATE TEMP TABLE move_result($fragment$;
  selection_lock text := $fragment$END LOOP;
  LOCK TABLE hub_report_subscription_project IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE move_result($fragment$;
  count_fragment text := $fragment$END LOOP;
  SELECT sum(mr.row_count) INTO total FROM move_result mr;$fragment$;
  selection_count text := $fragment$END LOOP;
  EXECUTE 'SELECT count(*) FROM hub_report_subscription_project WHERE project_id=$1'
    INTO total USING project_id;
  UPDATE move_result SET row_count=total
  WHERE table_name='hub_report_subscription_project';
  SELECT sum(mr.row_count) INTO total FROM move_result mr;$fragment$;
  move_fragment text := $fragment$ALTER TABLE project FORCE ROW LEVEL SECURITY;
    FOR candidate IN$fragment$;
  selection_move text := $fragment$ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription_project NO FORCE ROW LEVEL SECURITY;
    EXECUTE 'UPDATE hub_report_subscription_project SET project_space_id=$1 WHERE project_id=$2'
      USING destination_id, project_id;
    ALTER TABLE hub_report_subscription_project FORCE ROW LEVEL SECURITY;
    FOR candidate IN$fragment$;
  result_fragment text := $fragment$WHERE mr.table_name IN (SELECT mp.name FROM move_plan mp);$fragment$;
  selection_result text := $fragment$WHERE mr.table_name IN (SELECT mp.name FROM move_plan mp)
       OR mr.table_name='hub_report_subscription_project';$fragment$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(direct_candidate IN definition) = 0
    OR position(candidate_fragment IN definition) = 0
    OR position(recipient_reason IN definition) = 0
    OR position(lock_fragment IN definition) = 0
    OR position(count_fragment IN definition) = 0
    OR position(move_fragment IN definition) = 0
    OR position(result_fragment IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space definition does not match the expected predecessor';
  END IF;
  definition := replace(definition, direct_candidate, excluded_direct);
  definition := replace(definition, candidate_fragment, excluded_fragment);
  definition := replace(definition, recipient_reason, selection_reason);
  definition := replace(definition, lock_fragment, selection_lock);
  definition := replace(definition, count_fragment, selection_count);
  definition := replace(definition, move_fragment, selection_move);
  definition := replace(definition, result_fragment, selection_result);
  EXECUTE definition;
END
$migration$;
