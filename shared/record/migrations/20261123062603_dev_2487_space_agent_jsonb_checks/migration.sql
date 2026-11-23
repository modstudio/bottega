ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_request_settings_not_json_string_check" CHECK (jsonb_typeof("request_settings") <> 'string') NOT VALID;
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_jobs_not_json_string_check" CHECK (jsonb_typeof("jobs") <> 'string') NOT VALID;
ALTER TABLE "space_agent" ADD CONSTRAINT "space_agent_preferred_jobs_not_json_string_check" CHECK (jsonb_typeof("preferred_jobs") <> 'string') NOT VALID;
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_request_settings_not_json_string_check";
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_jobs_not_json_string_check";
ALTER TABLE "space_agent" VALIDATE CONSTRAINT "space_agent_preferred_jobs_not_json_string_check";
