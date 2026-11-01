CREATE OR REPLACE FUNCTION record_move_project_space(
  source_space text,
  project_name text,
  destination_space text,
  confirmed_total bigint DEFAULT NULL
)
RETURNS TABLE(table_name text, reached_by text, row_count bigint, moved boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  source_id uuid;
  destination_id uuid;
  moving_project_id uuid;
  candidate record;
  total bigint;
  collisions text;
  project_collision boolean;
  profile_conflicts text;
  historical_pin_conflicts text;
  missing_lenses text;
  unique_columns text;
  unique_join text;
  unique_key text;
  constraint_table text;
  constraint_name text;
  constraint_detail text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'record project move requires a signed-in user';
  END IF;

  SELECT s.id INTO source_id
  FROM membership m JOIN space s ON s.id=m.space_id
  WHERE m.user_id=actor_id AND (s.id::text=source_space OR s.slug=source_space);
  IF source_id IS NULL THEN
    RAISE EXCEPTION 'source record space % is not one of the signed-in user''s memberships; join it first with an invitation, then retry', source_space;
  END IF;

  SELECT s.id INTO destination_id
  FROM membership m JOIN space s ON s.id=m.space_id
  WHERE m.user_id=actor_id AND m.role='owner'
    AND (s.id::text=destination_space OR s.slug=destination_space);
  IF destination_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM membership m JOIN space s ON s.id=m.space_id
      WHERE m.user_id=actor_id AND (s.id::text=destination_space OR s.slug=destination_space)
    ) THEN
      RAISE EXCEPTION 'destination record space % requires the owner role; ask its owner to promote the caller, then retry', destination_space;
    END IF;
    RAISE EXCEPTION 'destination record space % does not exist or is not visible to the caller; create it or join it as owner, then retry', destination_space;
  END IF;
  IF source_id=destination_id THEN
    RAISE EXCEPTION 'source and destination record spaces are the same: %', source_space;
  END IF;

  PERFORM set_config('app.space_id', source_id::text, true);
  SELECT p.id INTO moving_project_id FROM project p
  WHERE p.space_id=source_id AND p.name=project_name;
  IF moving_project_id IS NULL THEN
    RAISE EXCEPTION 'project % does not exist in source record space %', project_name, source_space;
  END IF;

  CREATE TEMP TABLE project_space_classification(
    name text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('project','parent','space'))
  ) ON COMMIT DROP;
  INSERT INTO project_space_classification(name,kind) VALUES
    ('branch_disposal','project'),('config_entry','space'),('config_secret','space'),('contention','parent'),
    ('doc','project'),('doc_related_subject','parent'),('doc_revision','project'),
    ('hub_change','space'),('hub_change_head','space'),('hub_day','space'),
    ('hub_interval','project'),('hub_note','project'),('hub_note_acknowledgement','project'),
    ('hub_report_subscription','project'),('hub_report_subscription_member','parent'),
    ('hub_report_subscription_project','space'),('hub_report_subscription_recipient','parent'),
    ('hub_send','space'),('hub_send_recipient','space'),('hub_task','project'),
    ('hub_task_comment','project'),('hub_task_document','project'),
    ('hub_task_status_event','project'),('invitation','space'),('landing','project'),
    ('landing_override','project'),('landing_review_carry','project'),
    ('landing_triage_snapshot','project'),('pull_request_ci','project'),('lens','space'),('lens_profile','space'),
    ('lens_profile_revision','space'),('lens_revision','space'),('machine_name_claim','space'),('machine_public_key','space'),
    ('membership','space'),('operator_waiting_email','space'),('orch_snapshot','space'),
    ('port_baseline','parent'),('port_doctrine','space'),('port_pair','project'),
    ('port_ref','project'),('port_ref_source','parent'),('port_skip','parent'),
    ('project','project'),('project_lens_profile','project'),
    ('project_lens_profile_revision','parent'),('public_doc_space','project'),
    ('question','project'),('question_mutation_audit','parent'),('release','project'),
    ('review','project'),('review_finding','parent'),('review_lens','parent'),
    ('review_read','project'),('run','project'),('run_exclusion','parent'),
    ('run_score','parent'),('secret_dek','space'),('secret_dek_wrap','space'),
    ('seq','project'),('step_catalogue','space'),('step_catalogue_event','space'),
    ('step_catalogue_version','space'),('subject','project'),('test_flake','project'),
    ('workflow','space'),('workflow_event','space'),('workflow_version','space');

  SELECT string_agg(c.table_name, ', ' ORDER BY c.table_name) INTO collisions
  FROM (SELECT DISTINCT ic.table_name FROM information_schema.columns ic
        WHERE ic.table_schema='public' AND ic.column_name='space_id') c
  LEFT JOIN project_space_classification d ON d.name=c.table_name
  WHERE d.name IS NULL;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'project move space classification is missing hosted tables: %; classify them before moving a project',collisions;
  END IF;

  CREATE TEMP TABLE project_ownership(
    name text NOT NULL,
    owner_column text,
    parent_name text,
    parent_column text,
    path text NOT NULL,
    CHECK ((owner_column IS NULL) <> (parent_name IS NULL))
  ) ON COMMIT DROP;
  INSERT INTO project_ownership(name,owner_column,parent_name,parent_column,path) VALUES
    ('project','id',NULL,NULL,'project.id'),
    ('branch_disposal','project_id',NULL,NULL,'project_id'),
    ('doc','project_id',NULL,NULL,'project_id'),
    ('doc_revision','project_id',NULL,NULL,'project_id'),
    ('hub_interval','project_id',NULL,NULL,'project_id or project_name or hub_task.task_key'),
    ('hub_interval','project_name',NULL,NULL,'project_id or project_name or hub_task.task_key'),
    ('hub_interval','task_key',NULL,NULL,'project_id or project_name or hub_task.task_key'),
    ('hub_note','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_note','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_note_acknowledgement','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_note_acknowledgement','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_report_subscription','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_report_subscription','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_task','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_task','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_task_comment','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_task_comment','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_task_document','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_task_document','project_name',NULL,NULL,'project_id or project_name'),
    ('hub_task_status_event','project_id',NULL,NULL,'project_id or project_name'),
    ('hub_task_status_event','project_name',NULL,NULL,'project_id or project_name'),
    ('landing','project_id',NULL,NULL,'project_id'),
    ('landing_override','project_id',NULL,NULL,'project_id'),
    ('landing_review_carry','project_id',NULL,NULL,'project_id'),
    ('landing_triage_snapshot','project_id',NULL,NULL,'project_id'),
    ('pull_request_ci','project_id',NULL,NULL,'project_id'),
    ('project_lens_profile','project_id',NULL,NULL,'project_id'),
    ('public_doc_space','project_id',NULL,NULL,'project_id'),
    ('question','project_id',NULL,NULL,'project_id'),
    ('release','project_id',NULL,NULL,'project_id'),
    ('review','project_id',NULL,NULL,'project_id'),
    ('review_read','project_id',NULL,NULL,'project_id'),
    ('run','project_id',NULL,NULL,'project_id'),
    ('seq','project_id',NULL,NULL,'project_id'),
    ('subject','project_id',NULL,NULL,'project_id'),
    ('test_flake','project_id',NULL,NULL,'project_id'),
    ('port_pair','target_project_id',NULL,NULL,'target_project_id'),
    ('port_ref','target_project_id',NULL,NULL,'target_project_id'),
    ('contention',NULL,'run','run_id','run.run_id or landing.landing_id'),
    ('contention',NULL,'landing','landing_id','run.run_id or landing.landing_id'),
    ('doc_related_subject',NULL,'doc','doc_id','doc.doc_id'),
    ('hub_report_subscription_member',NULL,'hub_report_subscription','subscription_id','hub_report_subscription.subscription_id'),
    ('hub_report_subscription_recipient',NULL,'hub_report_subscription','subscription_id','hub_report_subscription.subscription_id'),
    ('project_lens_profile_revision',NULL,'project_lens_profile','selection_id','project_lens_profile.selection_id'),
    ('question_mutation_audit',NULL,'question','question_id','question.question_id'),
    ('review_lens',NULL,'review','review_id','review.review_id'),
    ('review_finding',NULL,'review','review_id','review.review_id'),
    ('run_exclusion',NULL,'run','run_id','run.run_id'),
    ('run_score',NULL,'run','run_id','run.run_id'),
    ('port_baseline',NULL,'port_pair','pair_id','port_pair.pair_id'),
    ('port_skip',NULL,'port_pair','pair_id','port_pair.pair_id'),
    ('port_ref_source',NULL,'port_ref','ref_id','port_ref.ref_id');

  SELECT string_agg(format('%s (%s)', c.relname, con.conname), ', ' ORDER BY c.relname,con.conname)
    INTO collisions
  FROM pg_constraint con
  JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_class parent ON parent.oid=con.confrelid
  WHERE con.contype='f' AND parent.relname='project'
    AND array_length(con.conkey,1)>1
    AND EXISTS (
      SELECT 1 FROM unnest(con.conkey) key(attnum)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum
      WHERE a.attname='space_id'
    )
    AND NOT EXISTS (SELECT 1 FROM project_ownership o WHERE o.name=c.relname);
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'project move ownership declaration is missing same-space project tables: %; declare their ownership in record_move_project_space, then retry', collisions;
  END IF;

  CREATE TEMP TABLE move_plan(name text PRIMARY KEY,predicate text NOT NULL,path text NOT NULL) ON COMMIT DROP;
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
  END LOOP;
  FOR candidate IN SELECT name FROM move_plan ORDER BY name LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',candidate.name);
  END LOOP;
  LOCK TABLE hub_report_subscription_project,lens,lens_profile,lens_profile_revision IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE move_result(table_name text PRIMARY KEY,reached_by text NOT NULL,row_count bigint NOT NULL,moved boolean NOT NULL) ON COMMIT DROP;
  CREATE TEMP TABLE move_row(table_name text NOT NULL,locator tid NOT NULL,PRIMARY KEY(table_name,locator)) ON COMMIT DROP;
  FOR candidate IN
    SELECT c.table_name,mp.predicate,mp.path
    FROM (SELECT DISTINCT ic.table_name FROM information_schema.columns ic WHERE ic.table_schema='public' AND ic.column_name='space_id') c
    LEFT JOIN move_plan mp ON mp.name=c.table_name ORDER BY c.table_name
  LOOP
    IF candidate.predicate IS NULL THEN
      INSERT INTO move_result VALUES(candidate.table_name,
        CASE candidate.table_name
          WHEN 'hub_day' THEN 'space-and-day aggregate; no project attribution'
          WHEN 'hub_send' THEN 'space send; projects may name several projects'
          WHEN 'hub_send_recipient' THEN 'space send recipient; parent send is not project-attributable'
          WHEN 'hub_report_subscription_project' THEN 'report selection; space reference updated, ownership kept'
          WHEN 'hub_report_setting' THEN 'space-level setting; no project attribution'
          WHEN 'orch_snapshot' THEN 'space-level snapshot; no project attribution'
          ELSE 'not declared as project-owned'
        END,0,false);
    ELSE
      EXECUTE format('INSERT INTO move_row SELECT %L,t.ctid FROM %I t WHERE t.space_id=$1 AND (%s)',candidate.table_name,candidate.table_name,candidate.predicate) USING source_id;
      SELECT count(*) INTO total FROM move_row mr WHERE mr.table_name=candidate.table_name;
      INSERT INTO move_result VALUES(candidate.table_name,candidate.path,total,false);
    END IF;
  END LOOP;

  -- Preflight every ordinary destination-scoped unique key touched by the move.
  -- This is deliberately catalogue-driven: adding another unique key to an
  -- owned table automatically makes dry-run exercise it before confirmation.
  collisions := NULL;
  FOR candidate IN
    SELECT c.relname table_name,ic.relname index_name,
      string_agg(CASE WHEN i.indnullsnotdistinct
          THEN format('s.%I IS NOT DISTINCT FROM d.%I',a.attname,a.attname)
          ELSE format('s.%I = d.%I',a.attname,a.attname)
        END,
        ' AND ' ORDER BY k.ordinality) FILTER (WHERE a.attname<>'space_id') unique_join,
      'jsonb_build_object(' || string_agg(
        format('%L,s.%I',a.attname,a.attname),',' ORDER BY k.ordinality
      ) FILTER (WHERE a.attname<>'space_id') || ')' unique_key
    FROM pg_index i
    JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_class ic ON ic.oid=i.indexrelid
    JOIN move_plan mp ON mp.name=c.relname
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON true
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
    WHERE i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND 0<>ALL(i.indkey)
    GROUP BY c.relname,ic.relname,i.indnullsnotdistinct
    HAVING bool_or(a.attname='space_id')
      AND count(*) FILTER (WHERE a.attname<>'space_id')>0
    ORDER BY c.relname,ic.relname
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY',candidate.table_name);
    EXECUTE format(
      'SELECT string_agg(format(%L,%s), '', '' ORDER BY %s::text) '
      'FROM %I s JOIN move_row mr ON mr.table_name=%L AND mr.locator=s.ctid '
      'JOIN %I d ON d.space_id=$1 AND %s WHERE s.space_id=$2',
      candidate.table_name || ' (' || candidate.index_name || ') key %s',
      candidate.unique_key,candidate.unique_key,candidate.table_name,candidate.table_name,
      candidate.table_name,candidate.unique_join)
      INTO unique_columns USING destination_id,source_id;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname=candidate.table_name AND c.relrowsecurity) THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',candidate.table_name);
    END IF;
    IF unique_columns IS NOT NULL THEN
      collisions := concat_ws(', ',collisions,unique_columns);
    END IF;
  END LOOP;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'project % cannot move from space % to space % because destination unique keys conflict: %',
      project_name,source_space,destination_space,collisions;
  END IF;

  EXECUTE 'SELECT count(*) FROM hub_report_subscription_project WHERE project_id=$1' INTO total USING moving_project_id;
  UPDATE move_result mr SET row_count=total WHERE mr.table_name='hub_report_subscription_project';
  SELECT sum(mr.row_count) INTO total FROM move_result mr;

  ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
  EXECUTE 'SELECT string_agg(src.key, '', '' ORDER BY src.key) FROM hub_task src JOIN hub_task dst ON dst.space_id=$1 AND dst.key=src.key WHERE src.space_id=$2 AND (src.project_id=$3 OR src.project_name=$4)'
    INTO collisions USING destination_id,source_id,moving_project_id,project_name;
  ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
  IF collisions IS NOT NULL THEN RAISE EXCEPTION 'destination record space has colliding task keys: %',collisions; END IF;
  ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
  SELECT EXISTS(SELECT 1 FROM project WHERE space_id=destination_id AND name=project_name) INTO project_collision;
  ALTER TABLE project FORCE ROW LEVEL SECURITY;
  IF project_collision THEN RAISE EXCEPTION 'destination record space already has project name %',project_name; END IF;

  ALTER TABLE lens NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
  CREATE TEMP TABLE selected_profile_map AS
    SELECT DISTINCT sl.key lens_key,sp.axis,sp.name,sp.id source_profile_id,
      dl.id destination_lens_id,dp.id destination_profile_id,
      dp.id IS NULL copy_profile,sp.version,sp.body,sp.enabled,sp.updated_at
    FROM project_lens_profile s
    JOIN lens sl ON sl.space_id=source_id AND (s.lens_id=sl.id OR s.lens_id IS NULL)
    JOIN lens_profile sp ON sp.space_id=source_id AND sp.lens_id=sl.id
      AND sp.axis=s.axis AND sp.name=s.profile_name
    LEFT JOIN lens dl ON dl.space_id=destination_id AND dl.key=sl.key
    LEFT JOIN lens_profile dp ON dp.space_id=destination_id AND dp.lens_id=dl.id
      AND dp.axis=sp.axis AND dp.name=sp.name
    WHERE s.space_id=source_id AND s.project_id=moving_project_id;
  SELECT string_agg(format('%s/%s/%s',lens_key,axis,name),', ' ORDER BY lens_key,axis,name)
    INTO missing_lenses FROM selected_profile_map WHERE destination_lens_id IS NULL;
  IF missing_lenses IS NOT NULL THEN
    ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens FORCE ROW LEVEL SECURITY;
    RAISE EXCEPTION 'project % cannot move from space % to space % because destination lenses are missing for selected profiles: %',project_name,source_space,destination_space,missing_lenses;
  END IF;
  SELECT string_agg(format('%s/%s/%s',m.lens_key,m.axis,m.name),', ' ORDER BY m.lens_key,m.axis,m.name)
    INTO profile_conflicts
  FROM selected_profile_map m JOIN lens_profile dp ON dp.id=m.destination_profile_id
  WHERE dp.body IS DISTINCT FROM m.body OR dp.enabled IS DISTINCT FROM m.enabled;
  ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens FORCE ROW LEVEL SECURITY;
  IF profile_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'project % cannot move from space % to space % because lens profiles have different current content: %; reconcile them, then retry',project_name,source_space,destination_space,profile_conflicts;
  END IF;

  ALTER TABLE lens NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens_profile_revision NO FORCE ROW LEVEL SECURITY;
  CREATE TEMP TABLE live_pin_map AS
    SELECT s.id selection_id,sl.key lens_key,s.axis,s.profile_name,
      CASE WHEN s.selected_version_id=sp.current_version_id THEN sp.version ELSE sr.version END source_version,
      CASE
        WHEN s.selected_version_id=sp.current_version_id
          THEN jsonb_build_object('body',sp.body::jsonb,'enabled',sp.enabled)
        ELSE sr.prior_body::jsonb
      END source_content,
      CASE
        WHEN s.selected_version_id IS NULL THEN NULL
        WHEN m.copy_profile THEN NULL
        WHEN spv.version=dp.version THEN dp.current_version_id
        ELSE dr.id
      END destination_version_id,
      CASE
        WHEN s.selected_version_id IS NULL OR m.copy_profile THEN NULL
        WHEN spv.version=dp.version
          THEN jsonb_build_object('body',dp.body::jsonb,'enabled',dp.enabled)
        ELSE dr.prior_body::jsonb
      END destination_content,
      m.copy_profile
    FROM project_lens_profile s
    JOIN lens sl ON sl.space_id=source_id AND (s.lens_id=sl.id OR s.lens_id IS NULL)
    JOIN lens_profile sp ON sp.space_id=source_id AND sp.lens_id=sl.id
      AND sp.axis=s.axis AND sp.name=s.profile_name
    LEFT JOIN lens_profile_revision sr ON sr.profile_id=sp.id AND sr.id=s.selected_version_id
    CROSS JOIN LATERAL (SELECT CASE
      WHEN s.selected_version_id=sp.current_version_id THEN sp.version ELSE sr.version END version) spv
    JOIN selected_profile_map m ON m.lens_key=sl.key AND m.axis=s.axis AND m.name=s.profile_name
    LEFT JOIN lens_profile dp ON dp.id=m.destination_profile_id
    LEFT JOIN lens_profile_revision dr ON dr.profile_id=dp.id AND dr.version=spv.version
    WHERE s.space_id=source_id AND s.project_id=moving_project_id;
  SELECT string_agg(
      format('project %s lens %s profile %s version %s from space %s differs from or is missing in space %s',
        project_name,lens_key,profile_name,source_version,source_space,destination_space),
      ', ' ORDER BY lens_key,profile_name,source_version)
    INTO profile_conflicts
  FROM live_pin_map
  WHERE source_version IS NOT NULL
    AND NOT copy_profile
    AND (destination_version_id IS NULL OR source_content IS DISTINCT FROM destination_content);
  CREATE TEMP TABLE historical_pin_map AS
    SELECT r.id revision_id,sl.key lens_key,s.axis,r.prior_profile_name,
      CASE WHEN r.prior_selected_version_id=sp.current_version_id THEN sp.version ELSE sr.version END source_version,
      CASE
        WHEN r.prior_selected_version_id=sp.current_version_id
          THEN jsonb_build_object('body',sp.body::jsonb,'enabled',sp.enabled)
        ELSE sr.prior_body::jsonb
      END source_content,
      CASE
        WHEN r.prior_selected_version_id IS NULL THEN NULL
        WHEN coalesce(m.copy_profile,false) THEN NULL
        WHEN spv.version=dp.version THEN dp.current_version_id
        ELSE dr.id
      END destination_version_id,
      CASE
        WHEN r.prior_selected_version_id IS NULL OR coalesce(m.copy_profile,false) THEN NULL
        WHEN spv.version=dp.version
          THEN jsonb_build_object('body',dp.body::jsonb,'enabled',dp.enabled)
        ELSE dr.prior_body::jsonb
      END destination_content,
      coalesce(m.copy_profile,false) copy_profile,
      r.prior_selected_version_id IS NOT NULL pinned
    FROM project_lens_profile_revision r
    JOIN project_lens_profile s ON s.id=r.selection_id
      AND s.space_id=source_id AND s.project_id=moving_project_id
    JOIN lens sl ON sl.space_id=source_id AND (s.lens_id=sl.id OR s.lens_id IS NULL)
    LEFT JOIN lens_profile sp ON sp.space_id=source_id AND sp.lens_id=sl.id
      AND sp.axis=s.axis AND sp.name=r.prior_profile_name
    LEFT JOIN lens_profile_revision sr ON sr.profile_id=sp.id AND sr.id=r.prior_selected_version_id
    CROSS JOIN LATERAL (SELECT CASE
      WHEN r.prior_selected_version_id=sp.current_version_id THEN sp.version ELSE sr.version END version) spv
    LEFT JOIN selected_profile_map m ON m.lens_key=sl.key AND m.axis=s.axis
      AND m.name=r.prior_profile_name
    LEFT JOIN lens dl ON dl.space_id=destination_id AND dl.key=sl.key
    LEFT JOIN lens_profile dp ON dp.space_id=destination_id AND dp.lens_id=dl.id
      AND dp.axis=s.axis AND dp.name=r.prior_profile_name
    LEFT JOIN lens_profile_revision dr ON dr.profile_id=dp.id AND dr.version=spv.version;
  SELECT string_agg(
      format('%s/%s/%s version %s',lens_key,axis,prior_profile_name,source_version),
      ', ' ORDER BY lens_key,axis,prior_profile_name,source_version)
    INTO historical_pin_conflicts
  FROM historical_pin_map
  WHERE pinned AND (
    source_version IS NULL OR
    (NOT copy_profile AND (
      destination_version_id IS NULL OR source_content IS DISTINCT FROM destination_content
    ))
  );
  ALTER TABLE lens_profile_revision FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
  ALTER TABLE lens FORCE ROW LEVEL SECURITY;
  IF profile_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'project lens profile pinned-version conflict: %',profile_conflicts;
  END IF;
  IF historical_pin_conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'project % cannot move from space % to space % because historical lens profile pins have no matching version in the destination: %; reconcile the destination profiles, then retry',
      project_name,source_space,destination_space,historical_pin_conflicts;
  END IF;

  IF confirmed_total IS NOT NULL AND confirmed_total<>total THEN
    RAISE EXCEPTION 'confirmation count % does not match current total %; run the dry run again',confirmed_total,total;
  END IF;

  -- A dry run exercises the exact mutation block used by confirmation.  Its
  -- private exception rolls back the nested transaction after every update has
  -- succeeded, including ALTER TABLE ... NO FORCE ROW LEVEL SECURITY changes.
  BEGIN
    ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
    INSERT INTO lens_profile(id,space_id,lens_id,axis,name,version,current_version_id,body,enabled,updated_at)
      SELECT gen_random_uuid(),destination_id,destination_lens_id,axis,name,version,gen_random_uuid(),body,enabled,updated_at
      FROM selected_profile_map WHERE destination_profile_id IS NULL;
    UPDATE selected_profile_map m SET destination_profile_id=p.id
      FROM lens_profile p WHERE p.space_id=destination_id AND p.lens_id=m.destination_lens_id
        AND p.axis=m.axis AND p.name=m.name;
    ALTER TABLE lens_profile_revision NO FORCE ROW LEVEL SECURITY;
    INSERT INTO lens_profile_revision(id,space_id,profile_id,version,prior_body,reason,session_id,at)
      SELECT gen_random_uuid(),destination_id,m.destination_profile_id,r.version,r.prior_body,r.reason,r.session_id,r.at
      FROM selected_profile_map m JOIN lens_profile_revision r ON r.profile_id=m.source_profile_id
      WHERE m.copy_profile;
    UPDATE live_pin_map pm SET destination_version_id=CASE
        WHEN pm.source_version=dp.version THEN dp.current_version_id
        ELSE (SELECT r.id FROM lens_profile_revision r
          WHERE r.profile_id=dp.id AND r.version=pm.source_version) END,
      destination_content=CASE
        WHEN pm.source_version=dp.version
          THEN jsonb_build_object('body',dp.body::jsonb,'enabled',dp.enabled)
        ELSE (SELECT r.prior_body::jsonb FROM lens_profile_revision r
          WHERE r.profile_id=dp.id AND r.version=pm.source_version) END
      FROM selected_profile_map m
      JOIN lens_profile dp ON dp.id=m.destination_profile_id
      WHERE pm.copy_profile AND pm.lens_key=m.lens_key AND pm.axis=m.axis AND pm.profile_name=m.name;
    UPDATE historical_pin_map pm SET destination_version_id=CASE
        WHEN pm.source_version=dp.version THEN dp.current_version_id
        ELSE (SELECT r.id FROM lens_profile_revision r
          WHERE r.profile_id=dp.id AND r.version=pm.source_version) END,
      destination_content=CASE
        WHEN pm.source_version=dp.version
          THEN jsonb_build_object('body',dp.body::jsonb,'enabled',dp.enabled)
        ELSE (SELECT r.prior_body::jsonb FROM lens_profile_revision r
          WHERE r.profile_id=dp.id AND r.version=pm.source_version) END
      FROM selected_profile_map m
      JOIN lens_profile dp ON dp.id=m.destination_profile_id
      WHERE pm.copy_profile AND pm.lens_key=m.lens_key AND pm.axis=m.axis
        AND pm.prior_profile_name=m.name;
    ALTER TABLE project_lens_profile_revision NO FORCE ROW LEVEL SECURITY;
    CREATE TEMP TABLE saved_selection_revision AS
      SELECT r.*,pm.destination_version_id resolved_prior_version_id
      FROM project_lens_profile_revision r
      JOIN project_lens_profile s ON s.id=r.selection_id
      JOIN historical_pin_map pm ON pm.revision_id=r.id
      WHERE s.space_id=source_id AND s.project_id=moving_project_id;
    ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY;
    CREATE TEMP TABLE saved_selection AS
      SELECT s.*,l.key lens_key,pm.destination_version_id resolved_version_id
      FROM project_lens_profile s
      LEFT JOIN lens l ON l.id=s.lens_id
      JOIN live_pin_map pm ON pm.selection_id=s.id
      WHERE s.space_id=source_id AND s.project_id=moving_project_id;
    DELETE FROM project_lens_profile WHERE space_id=source_id AND project_id=moving_project_id;

    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    UPDATE project SET space_id=destination_id WHERE id=moving_project_id AND space_id=source_id;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription_project NO FORCE ROW LEVEL SECURITY;
    UPDATE hub_report_subscription_project SET project_space_id=destination_id WHERE project_id=moving_project_id;
    ALTER TABLE hub_report_subscription_project FORCE ROW LEVEL SECURITY;
    FOR candidate IN SELECT * FROM move_plan WHERE name NOT IN ('project','seq','project_lens_profile','project_lens_profile_revision','port_pair','port_baseline','port_skip','port_ref','port_ref_source') ORDER BY name LOOP
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY',candidate.name);
      EXECUTE format('UPDATE %I t SET space_id=$1 FROM move_row mr WHERE mr.table_name=%L AND t.ctid=mr.locator',candidate.name,candidate.name) USING destination_id;
      IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=candidate.name AND c.relrowsecurity) THEN
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',candidate.name);
      END IF;
    END LOOP;
    INSERT INTO project_lens_profile(id,space_id,project_id,lens_id,axis,profile_name,selected_version_id,selection_version,updated_at)
      SELECT s.id,destination_id,s.project_id,CASE WHEN s.lens_key IS NULL THEN NULL ELSE m.destination_lens_id END,
        s.axis,s.profile_name,s.resolved_version_id,s.selection_version,s.updated_at
      FROM saved_selection s LEFT JOIN selected_profile_map m ON m.lens_key=s.lens_key AND m.axis=s.axis AND m.name=s.profile_name;
    INSERT INTO project_lens_profile_revision(id,space_id,selection_id,prior_profile_name,prior_selected_version_id,reason,session_id,at)
      SELECT id,destination_id,selection_id,prior_profile_name,resolved_prior_version_id,reason,session_id,at
      FROM saved_selection_revision;
    ALTER TABLE project_lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE project_lens_profile_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
    UPDATE move_result mr SET moved=mr.row_count>0 WHERE mr.table_name IN (SELECT mp.name FROM move_plan mp) OR mr.table_name='hub_report_subscription_project';
    IF confirmed_total IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='P1214', MESSAGE='record project move dry-run rollback';
    END IF;
  EXCEPTION
    WHEN SQLSTATE 'P1214' THEN NULL;
    WHEN integrity_constraint_violation THEN
      GET STACKED DIAGNOSTICS
        constraint_table = TABLE_NAME,
        constraint_name = CONSTRAINT_NAME,
        constraint_detail = PG_EXCEPTION_DETAIL;
      IF confirmed_total IS NULL THEN
        RAISE EXCEPTION 'project % cannot move from space % to space % because the dry-run trial hit a constraint: table %, constraint %, key %',
          project_name,source_space,destination_space,
          coalesce(nullif(constraint_table,''),'<unknown>'),
          coalesce(nullif(constraint_name,''),'<unknown>'),
          coalesce(nullif(constraint_detail,''),'<no detail>');
      END IF;
      RAISE;
  END;
  RETURN QUERY SELECT r.table_name,r.reached_by,r.row_count,r.moved FROM move_result r ORDER BY r.table_name;
END;
$$;

REVOKE ALL ON FUNCTION record_move_project_space(text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_move_project_space(text,text,text,bigint) TO record_actor;
