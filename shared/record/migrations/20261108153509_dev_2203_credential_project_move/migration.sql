DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('branch_disposal','project'),('config_entry','space'),('config_secret','space'),('contention','parent')$anchor$;
  replacement_classification text := $anchor$('branch_disposal','project'),('config_entry','space'),('config_secret','project'),('credential_payer_preference','project'),('contention','parent')$anchor$;
  previous_ownership text := $anchor$('branch_disposal','project_id',NULL,NULL,'project_id'),
    ('doc','project_id',NULL,NULL,'project_id')$anchor$;
  replacement_ownership text := $anchor$('branch_disposal','project_id',NULL,NULL,'project_id'),
    ('config_secret','project_id',NULL,NULL,'project_id'),
    ('credential_payer_preference','project_id',NULL,NULL,'project_id'),
    ('doc','project_id',NULL,NULL,'project_id')$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0 OR position(previous_ownership IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space credential anchors are absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  EXECUTE replace(definition, previous_ownership, replacement_ownership);
END
$migration$;
--> statement-breakpoint
ALTER TABLE "credential_payer_preference" FORCE ROW LEVEL SECURITY;
