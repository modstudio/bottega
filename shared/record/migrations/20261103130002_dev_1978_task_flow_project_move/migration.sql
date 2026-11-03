DO $$
DECLARE
  definition text;
  rewritten text;
BEGIN
  definition := pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure);
  rewritten := replace(
    definition,
    '(''step_catalogue_version'',''space''),(''subject'',''project''),(''test_flake'',''project''),',
    '(''step_catalogue_version'',''space''),(''subject'',''project''),(''task_flow'',''project''),(''task_flow_stage'',''parent''),(''test_flake'',''project''),'
  );
  rewritten := replace(
    rewritten,
    '(''subject'',''project_id'',NULL,NULL,''project_id''),
    (''test_flake'',''project_id'',NULL,NULL,''project_id''),',
    '(''subject'',''project_id'',NULL,NULL,''project_id''),
    (''task_flow'',''project_id'',NULL,NULL,''project_id''),
    (''test_flake'',''project_id'',NULL,NULL,''project_id''),'
  );
  rewritten := replace(
    rewritten,
    '(''run_score'',NULL,''run'',''run_id'',''run.run_id''),
    (''port_baseline'',NULL,''port_pair'',''pair_id'',''port_pair.pair_id''),',
    '(''run_score'',NULL,''run'',''run_id'',''run.run_id''),
    (''task_flow_stage'',NULL,''task_flow'',''flow_record_id'',''task_flow.flow_record_id''),
    (''port_baseline'',NULL,''port_pair'',''pair_id'',''port_pair.pair_id''),'
  );
  IF rewritten = definition THEN
    RAISE EXCEPTION 'DEV-1978 could not extend record_move_project_space';
  END IF;
  EXECUTE rewritten;
END
$$;
