-- The composite seq reference is the one relationship whose parent key includes
-- space_id. Cascading that key lets the project row remain the identity owner.
ALTER TABLE "seq" DROP CONSTRAINT "seq_space_project_fk";
ALTER TABLE "seq" ADD CONSTRAINT "seq_space_project_fk"
  FOREIGN KEY ("space_id", "project_id") REFERENCES "project"("space_id", "id")
  ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION record_applied_migration_count()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, drizzle
AS $$ SELECT count(*)::integer FROM drizzle.__drizzle_migrations $$;

REVOKE ALL ON FUNCTION record_applied_migration_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_applied_migration_count() TO record_actor;

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
  project_id uuid;
  candidate record;
  parent record;
  predicates text;
  reasons text;
  changed boolean;
  total bigint;
  collisions text;
  project_collision boolean;
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
  SELECT p.id INTO project_id FROM project p
  WHERE p.space_id=source_id AND p.name=project_name;
  IF project_id IS NULL THEN
    RAISE EXCEPTION 'project % does not exist in source record space %', project_name, source_space;
  END IF;

  CREATE TEMP TABLE move_plan(
    name text PRIMARY KEY,
    predicate text NOT NULL,
    path text NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO move_plan VALUES ('project', format('t.id=%L::uuid', project_id), 'project.id');

  FOR candidate IN
    SELECT c.table_name,
      bool_or(c.column_name='project_id') AS by_id,
      bool_or(c.column_name='project_name') AS by_name
    FROM information_schema.columns c
    WHERE c.table_schema='public'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns s
        WHERE s.table_schema='public' AND s.table_name=c.table_name AND s.column_name='space_id'
      )
    GROUP BY c.table_name
    ORDER BY c.table_name
  LOOP
    IF candidate.table_name <> 'project' AND (candidate.by_id OR candidate.by_name) THEN
      predicates := concat_ws(' OR ',
        CASE WHEN candidate.by_id THEN format('t.project_id=%L::uuid', project_id) END,
        CASE WHEN candidate.by_name THEN format('t.project_name=%L', project_name) END);
      reasons := concat_ws(' or ',
        CASE WHEN candidate.by_id THEN 'project_id' END,
        CASE WHEN candidate.by_name THEN 'project_name' END);
      INSERT INTO move_plan VALUES (candidate.table_name, predicates, reasons);
    END IF;
  END LOOP;

  LOOP
    changed := false;
    FOR candidate IN
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='space_id'
        AND NOT EXISTS (SELECT 1 FROM move_plan mp WHERE mp.name=c.table_name)
      ORDER BY c.table_name
    LOOP
      predicates := NULL;
      reasons := NULL;
      FOR parent IN
        SELECT mp.name, mp.predicate, c.column_name
        FROM move_plan mp
        JOIN information_schema.columns idc
          ON idc.table_schema='public' AND idc.table_name=mp.name AND idc.column_name='id'
        JOIN information_schema.columns c
          ON c.table_schema='public' AND c.table_name=candidate.table_name
         AND c.column_name LIKE '%\_id' ESCAPE '\'
         AND (mp.name=left(c.column_name,-3) OR mp.name LIKE '%\_' || left(c.column_name,-3) ESCAPE '\')
        ORDER BY mp.name, c.column_name
      LOOP
        predicates := concat_ws(' OR ', predicates,
          format('EXISTS (SELECT 1 FROM %I p WHERE p.space_id=%L::uuid AND p.id=t.%I AND (%s))',
            parent.name, source_id, parent.column_name, replace(parent.predicate, 't.', 'p.')));
        reasons := concat_ws(' or ', reasons, format('%s.%s', parent.name, parent.column_name));
      END LOOP;
      IF predicates IS NOT NULL THEN
        INSERT INTO move_plan VALUES (candidate.table_name, predicates, reasons);
        changed := true;
      END IF;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  -- Intervals without a project_name still belong to a project when their task
  -- key resolves to that project's task in the same space.
  UPDATE move_plan
  SET predicate = predicate || format(
        ' OR EXISTS (SELECT 1 FROM hub_task p WHERE p.space_id=%L::uuid AND p.key=t.task_key AND p.project_name=%L)',
        source_id, project_name),
      path = 'project_name or hub_task.task_key'
  WHERE name='hub_interval';

  FOR candidate IN SELECT name FROM move_plan ORDER BY name LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', candidate.name);
  END LOOP;

  CREATE TEMP TABLE move_result(
    table_name text PRIMARY KEY,
    reached_by text NOT NULL,
    row_count bigint NOT NULL,
    moved boolean NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE move_row(
    table_name text NOT NULL,
    locator tid NOT NULL,
    PRIMARY KEY(table_name, locator)
  ) ON COMMIT DROP;
  FOR candidate IN
    SELECT c.tenant_table, mp.predicate, mp.path
    FROM (SELECT DISTINCT ic.table_name AS tenant_table FROM information_schema.columns ic
          WHERE ic.table_schema='public' AND ic.column_name='space_id') c
    LEFT JOIN move_plan mp ON mp.name=c.tenant_table
    ORDER BY c.tenant_table
  LOOP
    IF candidate.predicate IS NULL THEN
      INSERT INTO move_result VALUES (
        candidate.tenant_table,
        CASE candidate.tenant_table
          WHEN 'hub_day' THEN 'space-and-day aggregate; no project attribution'
          WHEN 'hub_send' THEN 'space send; projects may name several projects'
          WHEN 'hub_report_setting' THEN 'space-level setting; no project attribution'
          WHEN 'orch_snapshot' THEN 'space-level snapshot; no project attribution'
          ELSE 'no direct project identity or moving parent row'
        END,
        0,
        false
      );
    ELSE
      EXECUTE format(
        'INSERT INTO move_row(table_name,locator) SELECT %L,t.ctid FROM %I t WHERE t.space_id=$1 AND (%s)',
        candidate.tenant_table, candidate.tenant_table, candidate.predicate
      ) USING source_id;
      SELECT count(*) INTO total FROM move_row mr WHERE mr.table_name=candidate.tenant_table;
      INSERT INTO move_result VALUES (candidate.tenant_table, candidate.path, total, false);
    END IF;
  END LOOP;
  SELECT sum(mr.row_count) INTO total FROM move_result mr;

  ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
  EXECUTE 'SELECT string_agg(src.key, '', '' ORDER BY src.key) FROM hub_task src '
       || 'JOIN hub_task dst ON dst.space_id=$1 AND dst.key=src.key '
       || 'WHERE src.space_id=$2 AND src.project_name=$3'
    INTO collisions USING destination_id, source_id, project_name;
  ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'destination record space has colliding task keys: %', collisions;
  END IF;
  ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
  SELECT EXISTS (
    SELECT 1 FROM project p WHERE p.space_id=destination_id AND p.name=project_name
  ) INTO project_collision;
  ALTER TABLE project FORCE ROW LEVEL SECURITY;
  IF project_collision THEN
    RAISE EXCEPTION 'destination record space already has project name %', project_name;
  END IF;

  IF confirmed_total IS NOT NULL THEN
    IF confirmed_total <> total THEN
      RAISE EXCEPTION 'confirmation count % does not match current total %; run the dry run again', confirmed_total, total;
    END IF;
    -- Moving the project first cascades the composite project key into seq.
    -- Every other project reference uses the stable project id alone.
    SELECT * INTO candidate FROM move_plan WHERE name='project';
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    UPDATE project SET space_id=destination_id WHERE id=project_id AND space_id=source_id;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    FOR candidate IN
      SELECT * FROM move_plan WHERE name NOT IN ('project', 'seq') ORDER BY name
    LOOP
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', candidate.name);
      EXECUTE format(
        'UPDATE %I t SET space_id=$1 FROM move_row mr WHERE mr.table_name=%L AND t.ctid=mr.locator',
        candidate.name, candidate.name
      ) USING destination_id;
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', candidate.name);
    END LOOP;
    UPDATE move_result mr SET moved=mr.row_count > 0
    WHERE mr.table_name IN (SELECT mp.name FROM move_plan mp);
  END IF;

  RETURN QUERY SELECT mr.table_name, mr.reached_by, mr.row_count, mr.moved
    FROM move_result mr ORDER BY mr.table_name;
END;
$$;

REVOKE ALL ON FUNCTION record_move_project_space(text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_move_project_space(text,text,text,bigint) TO record_actor;
