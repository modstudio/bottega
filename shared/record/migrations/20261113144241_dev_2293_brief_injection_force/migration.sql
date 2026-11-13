ALTER TABLE "brief_injection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous text := '(''board_presence'',''project''),(''branch_disposal'',''project''),';
  replacement text := '(''board_presence'',''project''),(''branch_disposal'',''project''),(''brief_injection'',''space''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space board presence and branch disposal classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
