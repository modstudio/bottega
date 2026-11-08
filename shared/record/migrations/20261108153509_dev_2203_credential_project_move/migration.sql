DO $migration$
DECLARE
  definition text;
  previous text := '(''branch_disposal'',''project''),(''config_entry'',''space''),(''config_secret'',''space''),(''contention'',''parent'')';
  replacement text := '(''branch_disposal'',''project''),(''config_entry'',''space''),(''config_secret'',''project''),(''credential_payer_preference'',''project''),(''contention'',''parent'')';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space credential classification anchor is absent';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
