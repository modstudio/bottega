ALTER TABLE "config_secret" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('branch_disposal','project'),('config_entry','space'),('config_secret','space'),('contention','parent')$anchor$;
  replacement_classification text := $anchor$('branch_disposal','project'),('config_entry','space'),('config_secret','space'),('credential_payer_preference','project'),('contention','parent')$anchor$;
  previous_ownership text := $anchor$('branch_disposal','project_id',NULL,NULL,'project_id'),
    ('doc','project_id',NULL,NULL,'project_id')$anchor$;
  replacement_ownership text := $anchor$('branch_disposal','project_id',NULL,NULL,'project_id'),
    ('credential_payer_preference','project_id',NULL,NULL,'project_id'),
    ('doc','project_id',NULL,NULL,'project_id')$anchor$;
  variable_anchor text := $anchor$  constraint_detail text;$anchor$;
  variable_replacement text := $anchor$  constraint_detail text;
  credential_count bigint;$anchor$;
  preflight_anchor text := $anchor$  IF moving_project_id IS NULL THEN
    RAISE EXCEPTION 'project % does not exist in source record space %', project_name, source_space;
  END IF;

  CREATE TEMP TABLE project_space_classification$anchor$;
  preflight_replacement text := $anchor$  IF moving_project_id IS NULL THEN
    RAISE EXCEPTION 'project % does not exist in source record space %', project_name, source_space;
  END IF;

  SELECT count(*) INTO credential_count FROM config_secret
  WHERE space_id=source_id AND project_id=moving_project_id;
  IF credential_count > 0 THEN
    RAISE EXCEPTION 'project % has % bound credential(s); delete each with `bottega credential delete <provider>/<type> --project %`, then set it again in the destination space after the move', project_name, credential_count, project_name;
  END IF;

  CREATE TEMP TABLE project_space_classification$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0
    OR position(previous_ownership IN definition) = 0
    OR position(variable_anchor IN definition) = 0
    OR position(preflight_anchor IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space credential anchors are absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  definition := replace(definition, previous_ownership, replacement_ownership);
  definition := replace(definition, variable_anchor, variable_replacement);
  EXECUTE replace(definition, preflight_anchor, preflight_replacement);
END
$migration$;
--> statement-breakpoint
ALTER TABLE "config_secret" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credential_payer_preference" FORCE ROW LEVEL SECURITY;
