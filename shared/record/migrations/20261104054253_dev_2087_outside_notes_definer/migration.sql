-- Custom SQL migration file, put your code below! --
CREATE POLICY "hub_note_outside_author_select" ON public.hub_note
AS PERMISSIVE FOR SELECT TO record_actor
USING (author_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY "hub_note_owner_select" ON public.hub_note
AS PERMISSIVE FOR SELECT TO record_owner
USING (space_id IN (SELECT i.space_id FROM public.space_outside_intake i));

CREATE POLICY "hub_note_owner_insert" ON public.hub_note
AS PERMISSIVE FOR INSERT TO record_owner
WITH CHECK (space_id IN (SELECT i.space_id FROM public.space_outside_intake i));

CREATE POLICY "seq_owner_select" ON public.seq
AS PERMISSIVE FOR SELECT TO record_owner
USING (space_id IN (SELECT i.space_id FROM public.space_outside_intake i));

CREATE POLICY "seq_owner_insert" ON public.seq
AS PERMISSIVE FOR INSERT TO record_owner
WITH CHECK (space_id IN (SELECT i.space_id FROM public.space_outside_intake i));

CREATE POLICY "seq_owner_update" ON public.seq
AS PERMISSIVE FOR UPDATE TO record_owner
USING (space_id IN (SELECT i.space_id FROM public.space_outside_intake i))
WITH CHECK (space_id IN (SELECT i.space_id FROM public.space_outside_intake i));

-- The owner stays confined by project's tenant policy, so this lookup widens
-- app.space_ids to the intake spaces for its own read and restores the caller's value.
CREATE OR REPLACE FUNCTION public.outside_intake_for_project(p_name text)
RETURNS TABLE(project_id uuid, space_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  caller_space_ids text := current_setting('app.space_ids', true);
BEGIN
  PERFORM set_config(
    'app.space_ids',
    coalesce((SELECT string_agg(DISTINCT i.space_id::text, ',') FROM public.space_outside_intake i), ''),
    true
  );
  RETURN QUERY
    SELECT p.id, i.space_id
    FROM public.project p
    JOIN public.space_outside_intake i ON i.project_id = p.id AND i.space_id = p.space_id
    WHERE p.name = p_name AND p.retired_at IS NULL;
  PERFORM set_config('app.space_ids', coalesce(caller_space_ids, ''), true);
END;
$$;

ALTER FUNCTION public.outside_intake_for_project(text) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.outside_intake_for_project(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.outside_intake_for_project(text) TO record_actor;

CREATE OR REPLACE FUNCTION public.hub_note_insert_outside(
  p_id uuid,
  p_ledger_id uuid,
  p_author_user_id uuid,
  p_project_id uuid,
  p_project_name text,
  p_text text,
  p_area text,
  p_anchor text,
  p_created_at timestamptz
)
RETURNS TABLE(id uuid, number bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  intake_space_id uuid;
  highest_number bigint;
  sequence_next bigint;
  allocated_number bigint;
BEGIN
  -- Must match the per-user key taken by insertOutsideNote before counting ledger windows.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_author_user_id::text, 0));
  IF actor_id IS NULL OR actor_id IS DISTINCT FROM p_author_user_id THEN
    RAISE EXCEPTION 'outside note author must be the signed-in user';
  END IF;

  SELECT i.space_id INTO intake_space_id
  FROM public.space_outside_intake i
  WHERE i.project_id = p_project_id;
  IF intake_space_id IS NULL THEN
    RAISE EXCEPTION 'outside note project is not a space intake project';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.space_posting_block b
    WHERE b.space_id = intake_space_id AND b.user_id = actor_id
      AND (b.blocked_until IS NULL OR b.blocked_until > p_created_at)
  ) OR EXISTS (
    SELECT 1 FROM public.space_outside_intake i
    WHERE i.space_id = intake_space_id AND i.paused_until > p_created_at
  ) THEN
    RAISE EXCEPTION 'this space is not accepting outside posts right now';
  END IF;

  -- Must match lockNoteNumbers' '<project_id>:note' key in hub/src/hosted-notes.ts.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text || ':note', 0));
  SELECT COALESCE(max(n.number), 0) INTO highest_number
  FROM public.hub_note n
  WHERE n.space_id = intake_space_id AND n.project_name = p_project_name;
  SELECT COALESCE(s.next, 1) INTO sequence_next
  FROM public.seq s
  WHERE s.space_id = intake_space_id AND s.project_id = p_project_id AND s.name = 'note';
  allocated_number := GREATEST(highest_number + 1, sequence_next);

  INSERT INTO public.seq (id, space_id, project_id, name, next)
  VALUES (gen_random_uuid(), intake_space_id, p_project_id, 'note', allocated_number + 1)
  ON CONFLICT (space_id, project_id, name)
  DO UPDATE SET next = GREATEST(public.seq.next, excluded.next);

  INSERT INTO public.hub_note (
    id, space_id, project_name, project_id, author_user_id, number, project, text, area,
    anchors, sightings, created_at, last_seen_at, updated_at
  ) VALUES (
    p_id, intake_space_id, p_project_name, p_project_id, p_author_user_id, allocated_number,
    p_project_name, p_text, p_area, jsonb_build_array(p_anchor::jsonb)::text,
    1, p_created_at, p_created_at, p_created_at
  );

  INSERT INTO public.space_outside_write (id, space_id, user_id, kind, subject_id, created_at)
  VALUES (p_ledger_id, intake_space_id, actor_id, 'note', p_id, p_created_at);
  RETURN QUERY SELECT p_id, allocated_number;
END;
$$;

ALTER FUNCTION public.hub_note_insert_outside(
  uuid, uuid, uuid, uuid, text, text, text, text, timestamptz
) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.hub_note_insert_outside(
  uuid, uuid, uuid, uuid, text, text, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_note_insert_outside(
  uuid, uuid, uuid, uuid, text, text, text, text, timestamptz
) TO record_actor;
