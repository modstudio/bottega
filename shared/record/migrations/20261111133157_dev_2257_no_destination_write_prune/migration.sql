ALTER TABLE "no_destination_write" FORCE ROW LEVEL SECURITY;

DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('contention','parent')$anchor$;
  replacement_classification text := $anchor$('contention','parent'),('no_destination_write','space')$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space contention classification anchor is absent';
  END IF;
  EXECUTE replace(definition, previous_classification, replacement_classification);
END
$migration$;
