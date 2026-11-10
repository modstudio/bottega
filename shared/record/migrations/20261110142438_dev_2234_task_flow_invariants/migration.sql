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
ALTER TABLE "hub_task" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('task_flow','project'),('task_flow_stage','parent'),('test_flake','project')$anchor$;
  replacement_classification text := $anchor$('task_flow','project'),('task_flow_stage','parent'),('test_flake','project'),('workflow_obligation','parent'),('workflow_step_text','parent'),('workflow_text_copy','parent')$anchor$;
  previous_ownership text := $anchor$('task_flow_stage',NULL,'task_flow','flow_record_id','task_flow.flow_record_id')$anchor$;
  replacement_ownership text := $anchor$('task_flow_stage',NULL,'task_flow','flow_record_id','task_flow.flow_record_id'),
    ('workflow_obligation',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id'),
    ('workflow_step_text',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id'),
    ('workflow_text_copy',NULL,'task_flow_stage','stage_record_id','task_flow_stage.stage_record_id')$anchor$;
  previous_declarations text := $anchor$  collisions text;
  project_collision boolean;$anchor$;
  replacement_declarations text := $anchor$  collisions text;
  planned_count integer;
  nesting_depth integer;
  unresolved_owners text;
  project_collision boolean;$anchor$;
  previous_plan text := $anchor$  CREATE TEMP TABLE move_plan(name text PRIMARY KEY,predicate text NOT NULL,path text NOT NULL) ON COMMIT DROP;
  FOR candidate IN
    SELECT o.name,o.path,string_agg(
      CASE o.owner_column
        WHEN 'project_name' THEN format('t.%I=%L',o.owner_column,project_name)
        WHEN 'task_key' THEN format(
          'EXISTS (SELECT 1 FROM hub_task p WHERE p.space_id=%L::uuid AND p.key=t.task_key AND (p.project_id=%L::uuid OR p.project_name=%L))',
          source_id,moving_project_id,project_name)
        ELSE format('t.%I=%L::uuid',o.owner_column,moving_project_id)
      END,' OR ' ORDER BY o.owner_column) predicate
    FROM project_ownership o WHERE o.owner_column IS NOT NULL
    GROUP BY o.name,o.path ORDER BY o.name
  LOOP
    INSERT INTO move_plan VALUES(candidate.name,candidate.predicate,candidate.path);
  END LOOP;
  FOR candidate IN
    SELECT o.name,o.path,string_agg(
      format('EXISTS (SELECT 1 FROM %I p WHERE p.space_id=%L::uuid AND p.id=t.%I AND (%s))',
        o.parent_name,source_id,o.parent_column,replace(mp.predicate,'t.','p.')),
      ' OR ' ORDER BY o.parent_name) predicate
    FROM project_ownership o JOIN move_plan mp ON mp.name=o.parent_name
    WHERE o.parent_name IS NOT NULL GROUP BY o.name,o.path ORDER BY o.name
  LOOP
    INSERT INTO move_plan VALUES(candidate.name,candidate.predicate,candidate.path);
  END LOOP;$anchor$;
  replacement_plan text := $anchor$  CREATE TEMP TABLE move_plan(name text PRIMARY KEY,predicate text NOT NULL,path text NOT NULL) ON COMMIT DROP;
  FOR candidate IN
    SELECT o.name,o.path,string_agg(
      CASE o.owner_column
        WHEN 'project_name' THEN format('t.%I=%L',o.owner_column,project_name)
        WHEN 'task_key' THEN format(
          'EXISTS (SELECT 1 FROM hub_task p WHERE p.space_id=%L::uuid AND p.key=t.task_key AND (p.project_id=%L::uuid OR p.project_name=%L))',
          source_id,moving_project_id,project_name)
        ELSE format('t.%I=%L::uuid',o.owner_column,moving_project_id)
      END,' OR ' ORDER BY o.owner_column) predicate
    FROM project_ownership o WHERE o.owner_column IS NOT NULL
    GROUP BY o.name,o.path ORDER BY o.name
  LOOP
    INSERT INTO move_plan VALUES(candidate.name,candidate.predicate,candidate.path);
  END LOOP;

  nesting_depth := 1;
  LOOP
    planned_count := 0;
    FOR candidate IN
      SELECT o.name,o.path,string_agg(
        format('EXISTS (SELECT 1 FROM %I %I WHERE %I.space_id=%L::uuid AND %I.id=t.%I AND (%s))',
          o.parent_name,'p' || nesting_depth,'p' || nesting_depth,source_id,
          'p' || nesting_depth,o.parent_column,
          replace(mp.predicate,'t.',format('%I.','p' || nesting_depth))),
        ' OR ' ORDER BY o.parent_name) predicate
      FROM project_ownership o
      JOIN move_plan mp ON mp.name=o.parent_name
      WHERE o.parent_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM move_plan planned WHERE planned.name=o.name)
        AND NOT EXISTS (
          SELECT 1
          FROM project_ownership unresolved
          LEFT JOIN move_plan parent_plan ON parent_plan.name=unresolved.parent_name
          WHERE unresolved.name=o.name AND unresolved.parent_name IS NOT NULL
            AND parent_plan.name IS NULL
        )
      GROUP BY o.name,o.path ORDER BY o.name
    LOOP
      INSERT INTO move_plan VALUES(candidate.name,candidate.predicate,candidate.path);
      planned_count := planned_count + 1;
    END LOOP;
    EXIT WHEN planned_count = 0;
    nesting_depth := nesting_depth + 1;
  END LOOP;

  SELECT string_agg(DISTINCT o.name,', ' ORDER BY o.name) INTO unresolved_owners
  FROM project_ownership o
  LEFT JOIN move_plan mp ON mp.name=o.name
  WHERE o.parent_name IS NOT NULL AND mp.name IS NULL;
  IF unresolved_owners IS NOT NULL THEN
    RAISE EXCEPTION 'project move ownership parents cannot reach a project owner: %', unresolved_owners;
  END IF;$anchor$;
BEGIN
  SELECT pg_get_functiondef('public.record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0
    OR position(previous_ownership IN definition) = 0
    OR position(previous_declarations IN definition) = 0
    OR position(previous_plan IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space workflow instance anchors are absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  definition := replace(definition, previous_ownership, replacement_ownership);
  definition := replace(definition, previous_declarations, replacement_declarations);
  EXECUTE replace(definition, previous_plan, replacement_plan);
END
$migration$;
--> statement-breakpoint
ALTER TABLE "hub_task" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_obligation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_step_text" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_text_copy" FORCE ROW LEVEL SECURITY;
