ALTER TABLE "space_agent" FORCE ROW LEVEL SECURITY;

ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_request_settings_not_json_string_check" CHECK (jsonb_typeof("request_settings") <> 'string');
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_jobs_not_json_string_check" CHECK (jsonb_typeof("jobs") <> 'string');
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_preferred_jobs_not_json_string_check" CHECK (jsonb_typeof("preferred_jobs") <> 'string');

DO $migration$
DECLARE
  definition text;
  previous text := '(''space_outside_intake'',''project''),';
  replacement text := '(''space_agent'',''space''),(''space_outside_intake'',''project''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space outside intake classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
