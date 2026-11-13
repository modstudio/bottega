ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_facts_not_json_string_check" CHECK (jsonb_typeof("facts") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_path_set_not_json_string_check" CHECK (jsonb_typeof("path_set") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_verdict_not_json_string_check" CHECK (jsonb_typeof("verdict") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" ADD CONSTRAINT "review_funnel_decision_withheld_fields_not_json_string_check" CHECK (jsonb_typeof("withheld_fields") <> 'string') NOT VALID;
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_facts_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_path_set_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_verdict_not_json_string_check";
ALTER TABLE "review_funnel_decision" VALIDATE CONSTRAINT "review_funnel_decision_withheld_fields_not_json_string_check";
ALTER TABLE "review_funnel_decision" NO FORCE ROW LEVEL SECURITY;
DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('review','project'),('review_finding','parent'),$anchor$;
  replacement_classification text := $anchor$('review','project'),('review_finding','parent'),('review_funnel_decision','project'),$anchor$;
  previous_ownership text := $anchor$('review','project_id',NULL,NULL,'project_id'),$anchor$;
  replacement_ownership text := $anchor$('review','project_id',NULL,NULL,'project_id'),('review_funnel_decision','project_id',NULL,NULL,'project_id'),$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure) INTO definition;
  IF position(previous_classification IN definition) = 0 OR position(previous_ownership IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space review ownership anchors are missing';
  END IF;
  EXECUTE replace(replace(definition, previous_classification, replacement_classification), previous_ownership, replacement_ownership);
END
$migration$;
ALTER TABLE "review_funnel_decision" FORCE ROW LEVEL SECURITY;
