DO $$
DECLARE
  source_space constant uuid := '01990000-0000-7000-8000-000000000001';
  expected_count constant bigint := 47;
  found_count bigint;
  missing_count bigint;
  unlisted_count bigint;
  already_moved_count bigint;
  candidate record;
  affected bigint;
  migration_status text := 'move';
  foreign_owned text;
  external_references text;
BEGIN
  CREATE TEMP TABLE dev_1994_run(run_id uuid PRIMARY KEY, project_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO dev_1994_run VALUES
    ('01a0ab08-3fed-700e-9547-18a4c4d90129','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3fed-700f-bc2d-bf39fd2bcecd','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3fed-7010-97bf-356173041e20','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3fed-7014-9463-e6d460931c9a','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7001-8023-31484db4e12c','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7002-90ab-5c5c2092b266','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7003-a606-b1b64eb089c3','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7004-a425-bcaa84adb6e1','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7005-a677-fa54bea8716e','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff2-7006-9693-cfd3a326ec08','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff3-700b-aac3-1afdb6e819be','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff3-700c-896a-8b6bc76de1e8','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff3-700d-8192-dc5eb160e45d','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff3-700e-9856-99b30c1c3243','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff3-700f-97ee-91ac71e3131a','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff6-7008-9de1-7517d75c5f55','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-7009-a98a-8cc32eaeeaaa','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-700a-aabe-5237fd5ffd20','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-700b-b07b-153c016d20f9','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-700c-9dc1-d510853a32ef','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-700d-9ac2-19ac1b4daa0e','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff6-700e-a058-c65162ceff01','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff6-7010-807a-d49e94dfc642','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff6-7011-b91c-aa6a563a338c','01a0ab08-26bf-7000-b8bd-d50ee3bdae3b'),
    ('01a0ab08-3ff6-7016-b952-63a64ebe1b5a','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-7017-862a-37094f2e08c1','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-7018-8c4c-84d221b60502','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-7019-904f-6a17be050c5f','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff6-701b-a138-678d5fb09539','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff8-7000-98ba-47a798d8ca68','01a0ab08-26bf-7000-b8bd-d50ee3bdae3b'),
    ('01a0ab08-3ff9-7005-a0f8-93794288e313','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-3ff9-7006-8cc8-0fbf3800ea77','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-3ff9-7007-ba6d-0ebea6926b88','01a0ab08-26d0-7000-86c3-b81996f2fb1d'),
    ('01a0ab08-4004-7011-8537-3c9b9b4e807d','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7012-8364-f595aa1a8c66','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7013-9175-44a1d62cd9f2','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7014-a1f2-77344ec7850a','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7015-91db-84dd31cc9adc','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7016-aedf-da1206764ffe','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7017-abc2-cf5c3b1133b9','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7018-9bf2-20751bb180aa','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-7019-9a52-b21e100cb058','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-701a-bbb8-2e9a2fc04b39','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-701b-8680-5d3e0d55aa97','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-701c-b6d8-21e3307e7279','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-701d-954c-94814aca8e64','01a0ab08-26df-7000-a916-594f80673fb4'),
    ('01a0ab08-4004-701e-b3ba-31fe371aeec2','01a0ab08-26df-7000-a916-594f80673fb4');

  CREATE TEMP TABLE dev_1994_run_owned(table_name text, owner_column text, PRIMARY KEY(table_name,owner_column)) ON COMMIT DROP;
  INSERT INTO dev_1994_run_owned
  SELECT match[1],match[2]
  FROM regexp_matches(
    pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure),
    $pattern$\('([^']+)'\s*,\s*NULL\s*,\s*'run'\s*,\s*'([^']+)'\s*,\s*'[^']+'\)$pattern$,
    'g'
  ) match;
  IF NOT EXISTS (SELECT 1 FROM dev_1994_run_owned) THEN
    RAISE EXCEPTION 'DEV-1994 could not read run-parent ownership from record_move_project_space';
  END IF;
  SELECT string_agg(difference,', ' ORDER BY difference) INTO foreign_owned
  FROM (
    SELECT format('unexpected %s.%s',actual.table_name,actual.owner_column) difference
    FROM dev_1994_run_owned actual
    WHERE (actual.table_name,actual.owner_column) NOT IN (
      ('contention','run_id'),('run_exclusion','run_id'),('run_score','run_id')
    )
    UNION ALL
    SELECT format('missing %s.%s',expected.table_name,expected.owner_column)
    FROM (VALUES
      ('contention','run_id'),('run_exclusion','run_id'),('run_score','run_id')
    ) expected(table_name,owner_column)
    WHERE NOT EXISTS (
      SELECT 1 FROM dev_1994_run_owned actual
      WHERE actual.table_name=expected.table_name AND actual.owner_column=expected.owner_column
    )
  ) differences;
  IF foreign_owned IS NOT NULL THEN
    RAISE EXCEPTION 'DEV-1994 run-parent ownership differs from the supported set: %',foreign_owned;
  END IF;

  ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE run NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE contention NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE run_exclusion NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE run_score NO FORCE ROW LEVEL SECURITY;

  IF NOT EXISTS (SELECT 1 FROM run r JOIN dev_1994_run l ON l.run_id=r.id) THEN
    migration_status := 'absent';
    RAISE NOTICE 'DEV-1994: hosted record holds none of the listed runs; no rows changed';
  END IF;

  IF migration_status='move' THEN
    IF EXISTS (
      SELECT 1 FROM (SELECT DISTINCT project_id FROM dev_1994_run) listed
      LEFT JOIN project p ON p.id=listed.project_id WHERE p.id IS NULL
    ) THEN
      SELECT string_agg(listed.project_id::text,', ' ORDER BY listed.project_id) INTO foreign_owned
      FROM (SELECT DISTINCT project_id FROM dev_1994_run) listed
      LEFT JOIN project p ON p.id=listed.project_id WHERE p.id IS NULL;
      RAISE EXCEPTION 'DEV-1994 listed hosted projects are missing: %',foreign_owned;
    END IF;

    SELECT count(*) INTO found_count FROM run
    WHERE space_id=source_space AND NOT probe AND task_id IS NULL AND project_id IS NULL;
    SELECT count(*) INTO missing_count FROM dev_1994_run l
    WHERE NOT EXISTS (SELECT 1 FROM run r WHERE r.id=l.run_id AND r.space_id=source_space AND NOT r.probe AND r.task_id IS NULL AND r.project_id IS NULL);
    SELECT count(*) INTO unlisted_count FROM run r
    WHERE r.space_id=source_space AND NOT probe AND r.task_id IS NULL AND project_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM dev_1994_run l WHERE l.run_id=r.id);
    SELECT count(*) INTO already_moved_count FROM dev_1994_run l
    JOIN project p ON p.id=l.project_id
    JOIN run r ON r.id=l.run_id AND r.project_id=l.project_id AND r.space_id=p.space_id;

    IF found_count<>expected_count OR missing_count<>0 OR unlisted_count<>0 THEN
      IF already_moved_count=expected_count THEN
        migration_status := 'already-moved';
      ELSE
        RAISE EXCEPTION 'DEV-1994 stranded run set mismatch: found %, expected %, listed missing %, unlisted present %',found_count,expected_count,missing_count,unlisted_count;
      END IF;
    END IF;
    IF migration_status='already-moved' THEN
      RAISE NOTICE 'DEV-1994: all % listed runs are already in their target spaces and projects; no rows changed',expected_count;
    END IF;
  END IF;

  IF migration_status='move' THEN
    CREATE TEMP TABLE dev_1994_external_run_reference(table_name text,owner_column text,PRIMARY KEY(table_name,owner_column)) ON COMMIT DROP;
    INSERT INTO dev_1994_external_run_reference
    SELECT child.relname,child_column.attname
    FROM pg_constraint con
    JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_class parent ON parent.oid=con.confrelid AND parent.relname='run'
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY child_key(attnum,ordinality) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY parent_key(attnum,ordinality) ON parent_key.ordinality=child_key.ordinality
    JOIN pg_attribute child_column ON child_column.attrelid=child.oid AND child_column.attnum=child_key.attnum
    JOIN pg_attribute parent_column ON parent_column.attrelid=parent.oid AND parent_column.attnum=parent_key.attnum AND parent_column.attname='id'
    WHERE con.contype='f'
      AND NOT EXISTS (SELECT 1 FROM dev_1994_run_owned owned WHERE owned.table_name=child.relname AND owned.owner_column=child_column.attname);

    FOR candidate IN SELECT DISTINCT table_name FROM dev_1994_external_run_reference ORDER BY table_name LOOP
      IF candidate.table_name<>'run' AND EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(candidate.table_name) AND relrowsecurity) THEN
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY',candidate.table_name);
      END IF;
    END LOOP;
    FOR candidate IN SELECT * FROM dev_1994_external_run_reference ORDER BY table_name,owner_column LOOP
      IF candidate.table_name='run' THEN
        EXECUTE format(
          'SELECT count(*) FROM run t JOIN dev_1994_run target ON target.run_id=t.%I WHERE NOT EXISTS (SELECT 1 FROM dev_1994_run child WHERE child.run_id=t.id)',
          candidate.owner_column
        ) INTO affected;
      ELSE
        EXECUTE format('SELECT count(*) FROM %I t JOIN dev_1994_run l ON l.run_id=t.%I',candidate.table_name,candidate.owner_column) INTO affected;
      END IF;
      IF affected>0 THEN
        external_references := concat_ws(', ',external_references,format('%s=%s',candidate.table_name,affected));
      END IF;
    END LOOP;
    IF external_references IS NOT NULL THEN
      RAISE EXCEPTION 'DEV-1994 listed runs have non-owned foreign-key references: %',external_references;
    END IF;

    SELECT string_agg(format('contention=%s',space_id::text),', ' ORDER BY space_id::text) INTO foreign_owned
    FROM (SELECT t.space_id,count(*) row_count FROM contention t JOIN dev_1994_run l ON l.run_id=t.run_id WHERE t.space_id<>source_space GROUP BY t.space_id) foreign_rows;
    IF foreign_owned IS NOT NULL THEN
      RAISE EXCEPTION 'DEV-1994 run-owned rows in contention belong to another space: %',foreign_owned;
    END IF;
    SELECT string_agg(format('run_exclusion=%s',space_id::text),', ' ORDER BY space_id::text) INTO foreign_owned
    FROM (SELECT t.space_id,count(*) row_count FROM run_exclusion t JOIN dev_1994_run l ON l.run_id=t.run_id WHERE t.space_id<>source_space GROUP BY t.space_id) foreign_rows;
    IF foreign_owned IS NOT NULL THEN
      RAISE EXCEPTION 'DEV-1994 run-owned rows in run_exclusion belong to another space: %',foreign_owned;
    END IF;
    SELECT string_agg(format('run_score=%s',space_id::text),', ' ORDER BY space_id::text) INTO foreign_owned
    FROM (SELECT t.space_id,count(*) row_count FROM run_score t JOIN dev_1994_run l ON l.run_id=t.run_id WHERE t.space_id<>source_space GROUP BY t.space_id) foreign_rows;
    IF foreign_owned IS NOT NULL THEN
      RAISE EXCEPTION 'DEV-1994 run-owned rows in run_score belong to another space: %',foreign_owned;
    END IF;

    CREATE TEMP TABLE dev_1994_move_count(table_name text PRIMARY KEY,row_count bigint NOT NULL) ON COMMIT DROP;
    UPDATE contention t SET space_id=p.space_id
    FROM dev_1994_run l JOIN project p ON p.id=l.project_id
    WHERE t.run_id=l.run_id AND t.space_id=source_space;
    GET DIAGNOSTICS affected = ROW_COUNT;
    INSERT INTO dev_1994_move_count VALUES('contention',affected);
    UPDATE run_exclusion t SET space_id=p.space_id
    FROM dev_1994_run l JOIN project p ON p.id=l.project_id
    WHERE t.run_id=l.run_id AND t.space_id=source_space;
    GET DIAGNOSTICS affected = ROW_COUNT;
    INSERT INTO dev_1994_move_count VALUES('run_exclusion',affected);
    UPDATE run_score t SET space_id=p.space_id
    FROM dev_1994_run l JOIN project p ON p.id=l.project_id
    WHERE t.run_id=l.run_id AND t.space_id=source_space;
    GET DIAGNOSTICS affected = ROW_COUNT;
    INSERT INTO dev_1994_move_count VALUES('run_score',affected);

    UPDATE run r SET space_id=p.space_id,project_id=l.project_id
    FROM dev_1994_run l JOIN project p ON p.id=l.project_id
    WHERE r.id=l.run_id AND r.space_id=source_space;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected<>expected_count THEN
      RAISE EXCEPTION 'DEV-1994 moved % runs after guarding %, rolling back',affected,expected_count;
    END IF;

    FOR candidate IN
      SELECT p.space_id,count(*) row_count FROM dev_1994_run l JOIN project p ON p.id=l.project_id GROUP BY p.space_id ORDER BY p.space_id
    LOOP
      RAISE NOTICE 'DEV-1994 moved % runs to space %',candidate.row_count,candidate.space_id;
    END LOOP;
    FOR candidate IN SELECT * FROM dev_1994_move_count ORDER BY table_name LOOP
      RAISE NOTICE 'DEV-1994 moved % owned rows in table %',candidate.row_count,candidate.table_name;
    END LOOP;

    FOR candidate IN SELECT DISTINCT table_name FROM dev_1994_external_run_reference ORDER BY table_name LOOP
      IF candidate.table_name<>'run' AND EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass(candidate.table_name) AND relrowsecurity) THEN
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',candidate.table_name);
      END IF;
    END LOOP;
  END IF;
  ALTER TABLE contention FORCE ROW LEVEL SECURITY;
  ALTER TABLE run_exclusion FORCE ROW LEVEL SECURITY;
  ALTER TABLE run_score FORCE ROW LEVEL SECURITY;
  ALTER TABLE run FORCE ROW LEVEL SECURITY;
  ALTER TABLE project FORCE ROW LEVEL SECURITY;
END;
$$;
