ALTER TABLE "project" ADD CONSTRAINT "project_gate_tooling_not_json_string_check" CHECK (jsonb_typeof("gate_tooling") <> 'string') NOT VALID;
ALTER TABLE "project" ADD CONSTRAINT "project_gate_tooling_string_array_check" CHECK ("gate_tooling" IS NULL OR (jsonb_typeof("gate_tooling") = 'array' AND NOT jsonb_path_exists("gate_tooling", '$[*] ? (@.type() != "string")'))) NOT VALID;
