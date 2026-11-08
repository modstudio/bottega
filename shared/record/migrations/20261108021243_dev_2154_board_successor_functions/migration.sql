DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('branch_disposal','project'),('config_entry','space')$anchor$;
  replacement_classification text := $anchor$('board_presence','project'),('branch_disposal','project'),('config_entry','space')$anchor$;
  previous_ownership text := $anchor$('branch_disposal','project_id',NULL,NULL,'project_id'),$anchor$;
  replacement_ownership text := $anchor$('board_presence','project_id',NULL,NULL,'project_id'),('branch_disposal','project_id',NULL,NULL,'project_id'),$anchor$;
BEGIN
  SELECT pg_get_functiondef('public.record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0 OR position(previous_ownership IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space board presence anchors are absent';
  END IF;
  definition := replace(definition, previous_classification, replacement_classification);
  EXECUTE replace(definition, previous_ownership, replacement_ownership);
END
$migration$;
--> statement-breakpoint
ALTER TABLE "board_presence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.board_reply_elect_successor(
  p_message_id uuid,
  p_candidate_session text
)
RETURNS TABLE(elected boolean, holder text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  tenant_space_id uuid := nullif(current_setting('app.space_id', true), '')::uuid;
  root_id uuid;
  root_author_id uuid;
  root_author_session text;
  root_project_id uuid;
  live_since timestamptz := clock_timestamp() - interval '1 hour';
  current_holder text;
  current_holder_user_id uuid;
  current_delivered_at timestamptz;
  current_acknowledged_at timestamptz;
BEGIN
  IF actor_id IS NULL OR tenant_space_id IS NULL THEN
    RAISE EXCEPTION 'board successor election requires a signed-in tenant';
  END IF;
  IF p_message_id IS NULL OR nullif(btrim(p_candidate_session), '') IS NULL THEN
    RAISE EXCEPTION 'board successor election requires a reply and candidate session';
  END IF;

  SELECT reply.thread_root_id, root.author_user_id, root.author_session, root.author_project_id
  INTO root_id, root_author_id, root_author_session, root_project_id
  FROM public.board_message reply
  JOIN public.board_message root ON root.id = reply.thread_root_id
  WHERE reply.id = p_message_id AND reply.kind = 'reply';
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.project project
    JOIN public.membership member ON member.space_id = project.space_id
    WHERE project.id = root_project_id AND member.user_id = actor_id
  ) THEN RETURN; END IF;

  IF (root_author_session IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.board_presence presence
    WHERE presence.user_id = root_author_id
      AND presence.session = root_author_session
      AND presence.last_seen >= live_since
  )) OR EXISTS (
    SELECT 1 FROM public.board_receipt receipt
    WHERE receipt.message_id = p_message_id
      AND receipt.reader_user_id = root_author_id
      AND receipt.reader_session = root_author_session
      AND receipt.delivered_at IS NOT NULL
  ) THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  SELECT receipt.reader_session, receipt.reader_user_id, receipt.delivered_at, receipt.acknowledged_at
  INTO current_holder, current_holder_user_id, current_delivered_at, current_acknowledged_at
  FROM public.board_receipt receipt
  WHERE receipt.message_id = p_message_id AND receipt.successor
  LIMIT 1;

  IF current_holder IS NOT NULL AND (
    current_delivered_at IS NOT NULL OR current_acknowledged_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.board_presence presence
      WHERE presence.user_id = current_holder_user_id
        AND presence.session = current_holder
        AND presence.last_seen >= live_since
    )
  ) THEN
    RETURN QUERY SELECT false, current_holder;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.board_presence presence
    WHERE presence.space_id = tenant_space_id
      AND presence.user_id = actor_id
      AND presence.session = p_candidate_session
      AND presence.role = 'architect'
      AND presence.project_id = root_project_id
      AND presence.last_seen >= live_since
      AND NOT EXISTS (
        SELECT 1 FROM public.board_message participant
        WHERE (participant.id = root_id OR participant.thread_root_id = root_id)
          AND participant.author_session = p_candidate_session
      )
  ) THEN
    RETURN QUERY SELECT false, current_holder;
    RETURN;
  END IF;

  UPDATE public.board_receipt SET successor = false
  WHERE message_id = p_message_id AND successor;
  INSERT INTO public.board_receipt
    (id, message_id, reader_user_id, reader_session, audience_at_posting,
     delivered_at, acknowledged_at, successor)
  VALUES
    (gen_random_uuid(), p_message_id, actor_id, p_candidate_session, false, NULL, NULL, true)
  ON CONFLICT (message_id, reader_user_id, reader_session)
  DO UPDATE SET successor = true;
  UPDATE public.board_message
  SET revision = nextval('public.board_message_revision'::regclass)
  WHERE id = p_message_id;
  RETURN QUERY SELECT true, p_candidate_session;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.board_reply_elect_successor(uuid, text) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.board_reply_elect_successor(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.board_reply_elect_successor(uuid, text) TO record_actor;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.board_presence_prune()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted bigint;
BEGIN
  DELETE FROM public.board_presence
  WHERE last_seen < clock_timestamp() - interval '7 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.board_presence_prune() OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.board_presence_prune() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.board_presence_prune() TO record_actor;
