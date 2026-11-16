ALTER TABLE "context_review" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous text := '(''brief_injection'',''space''),(''hook_emission'',''space''),';
  replacement text := '(''brief_injection'',''space''),(''context_review'',''space''),(''hook_emission'',''space''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space session telemetry classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
