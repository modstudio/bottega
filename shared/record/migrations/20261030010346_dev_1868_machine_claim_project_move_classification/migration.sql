DO $$
DECLARE
  definition text;
  revised text;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  revised := replace(
    definition,
    '(''machine_public_key'',''space''),',
    '(''machine_name_claim'',''space''),(''machine_public_key'',''space''),'
  );
  IF revised = definition THEN
    RAISE EXCEPTION 'record_move_project_space classification anchor is missing';
  END IF;
  EXECUTE revised;
END $$;
