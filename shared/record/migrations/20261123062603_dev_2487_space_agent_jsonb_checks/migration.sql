ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_request_settings_not_json_string_check" CHECK (jsonb_typeof("request_settings") <> 'string') NOT VALID;
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_jobs_not_json_string_check" CHECK (jsonb_typeof("jobs") <> 'string') NOT VALID;
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_preferred_jobs_not_json_string_check" CHECK (jsonb_typeof("preferred_jobs") <> 'string') NOT VALID;
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_request_settings_not_json_string_check";
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_jobs_not_json_string_check";
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_preferred_jobs_not_json_string_check";

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
