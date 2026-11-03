DO $migration$
DECLARE
  definition text;
  previous text := '(''lens_profile_revision'',''space''),(''lens_revision'',''space''),(''machine_name_claim'',''space'')';
  replacement text := '(''lens_profile_revision'',''space''),(''lens_revision'',''space''),(''machine_key_claim_challenge'',''space''),(''machine_name_claim'',''space'')';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space classification anchor is absent';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
