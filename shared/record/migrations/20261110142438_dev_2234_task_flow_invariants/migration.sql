ALTER TABLE workflow_obligation ADD CONSTRAINT "workflow_obligation_satisfied_evidence_not_json_string_check" CHECK (jsonb_typeof("satisfied_evidence") <> 'string') NOT VALID;
--> statement-breakpoint
ALTER TABLE "workflow_obligation" VALIDATE CONSTRAINT "workflow_obligation_satisfied_evidence_not_json_string_check";
--> statement-breakpoint
ALTER TABLE "workflow_obligation" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_step_text" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_text_copy" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('task_flow','project'),('task_flow_stage','parent'),('test_flake','project')$anchor$;
  replacement_classification text := $anchor$('task_flow','project'),('task_flow_stage','project'),('test_flake','project'),('workflow_obligation','parent'),('workflow_step_text','parent'),('workflow_text_copy','parent')$anchor$;
  previous_ownership text := $anchor$('task_flow_stage',NULL,'task_flow','flow_record_id','task_flow.flow_record_id')$anchor$;
  replacement_ownership text := $anchor$('task_flow_stage','project_id',NULL,NULL,'project_id'),
    ('workflow_obligation',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id'),
    ('workflow_step_text',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id'),
    ('workflow_text_copy',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id')$anchor$;
BEGIN
  SELECT pg_get_functiondef('public.record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0
    OR position(previous_ownership IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space workflow instance anchors are absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  EXECUTE replace(definition, previous_ownership, replacement_ownership);
END
$migration$;
--> statement-breakpoint
ALTER TABLE "workflow_obligation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_step_text" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_text_copy" FORCE ROW LEVEL SECURITY;
