ALTER TABLE "space_outside_intake" FORCE ROW LEVEL SECURITY;
ALTER TABLE "space_posting_block" FORCE ROW LEVEL SECURITY;
ALTER TABLE "space_outside_write" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.project_is_outside_intake(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.space_outside_intake i
    WHERE i.project_id = p_project_id
  );
$$;

ALTER FUNCTION public.project_is_outside_intake(uuid) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.project_is_outside_intake(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_is_outside_intake(uuid) TO record_actor;

CREATE OR REPLACE FUNCTION public.board_message_insert_outside(
  p_id uuid,
  p_ledger_id uuid,
  p_author_user_id uuid,
  p_author_session text,
  p_author_harness text,
  p_author_machine_id uuid,
  p_author_run_id uuid,
  p_author_project_id uuid,
  p_kind text,
  p_purpose text,
  p_thread_root_id uuid,
  p_audience text,
  p_title text,
  p_body text,
  p_ack_required boolean,
  p_ack_deadline timestamptz,
  p_expires_at timestamptz,
  p_created_at timestamptz,
  p_scope_project_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  intake_space_id uuid;
  root_author_id uuid;
  root_scope uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_author_user_id::text, 0));
  IF actor_id IS NULL OR actor_id IS DISTINCT FROM p_author_user_id THEN
    RAISE EXCEPTION 'outside board author must be the signed-in user';
  END IF;

  SELECT i.space_id INTO intake_space_id
  FROM public.space_outside_intake i
  WHERE i.project_id = p_scope_project_id;
  IF intake_space_id IS NULL THEN
    RAISE EXCEPTION 'outside board scope is not a space intake project';
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

  IF p_kind = 'reply' THEN
    SELECT m.thread_root_author_user_id, m.scope_project_ids
      INTO root_author_id, root_scope
    FROM public.board_message m
    WHERE m.id = p_thread_root_id AND m.kind <> 'reply';
    IF root_author_id IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'outside replies are limited to the caller''s own threads';
    END IF;
    IF root_scope IS DISTINCT FROM ARRAY[p_scope_project_id]::uuid[] THEN
      RAISE EXCEPTION 'outside board scope is not the intake project';
    END IF;
  ELSIF p_thread_root_id IS NOT NULL THEN
    RAISE EXCEPTION 'outside board post cannot name a thread root';
  END IF;

  INSERT INTO public.board_message (
    id, author_user_id, author_session, author_harness, author_machine_id, author_run_id,
    author_project_id, kind, purpose, thread_root_id, audience, title, body, ack_required,
    ack_deadline, expires_at, created_at, claim_id, scope_project_ids, recipient_user_ids,
    shared_space_reach
  ) VALUES (
    p_id, p_author_user_id, p_author_session, p_author_harness, p_author_machine_id, p_author_run_id,
    p_author_project_id, p_kind, p_purpose,
    p_thread_root_id, p_audience, p_title, p_body, p_ack_required, p_ack_deadline, p_expires_at,
    p_created_at, NULL, ARRAY[p_scope_project_id]::uuid[], ARRAY[]::uuid[], false
  );

  INSERT INTO public.space_outside_write (id, space_id, user_id, kind, subject_id, created_at)
  VALUES (p_ledger_id, intake_space_id, actor_id,
    CASE WHEN p_kind = 'reply' THEN 'reply' ELSE 'post' END, p_id, p_created_at);
  RETURN p_id;
END;
$$;

ALTER FUNCTION public.board_message_insert_outside(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text, uuid, text, text, text,
  boolean, timestamptz, timestamptz, timestamptz, uuid
) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.board_message_insert_outside(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text, uuid, text, text, text,
  boolean, timestamptz, timestamptz, timestamptz, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.board_message_insert_outside(
  uuid, uuid, uuid, text, text, uuid, uuid, uuid, text, text, uuid, text, text, text,
  boolean, timestamptz, timestamptz, timestamptz, uuid
) TO record_actor;

DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('run_score','parent'),('secret_dek','space'),('secret_dek_wrap','space'),
    ('seq','project')$anchor$;
  replacement_classification text := $anchor$('run_score','parent'),('secret_dek','space'),('secret_dek_wrap','space'),
    ('space_outside_intake','project'),('space_outside_write','space'),('space_posting_block','space'),
    ('seq','project')$anchor$;
  previous_ownership text := $anchor$('run','project_id',NULL,NULL,'project_id'),
    ('seq','project_id',NULL,NULL,'project_id')$anchor$;
  replacement_ownership text := $anchor$('run','project_id',NULL,NULL,'project_id'),
    ('space_outside_intake','project_id',NULL,NULL,'project_id'),
    ('seq','project_id',NULL,NULL,'project_id')$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0 OR position(previous_ownership IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space outside-intake classification anchor is absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  EXECUTE replace(definition, previous_ownership, replacement_ownership);
END
$migration$;

