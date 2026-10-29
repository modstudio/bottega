-- A reply author cannot update a root owned by another user through board_message_actor_update.
-- This definer performs only the bounded expiry extension and revision advance needed after the
-- caller's reply exists. FORCE ROW LEVEL SECURITY remains active, and the existing owner policies
-- are the whole of its table access. BOARD_STANDING_DEFAULT_EXPIRY_MS in shared/board-duration.ts
-- owns the seven-day bound; replyRefusal in orchestrator/src/board/board-thread-policy.ts owns the
-- live question-or-notice root predicates mirrored here.
-- A true return with no change means the root already reaches the clamped target.
CREATE OR REPLACE FUNCTION public.board_message_extend_thread_expiry(
  p_root_id uuid,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  extended bigint := 0;
BEGIN
  IF p_root_id IS NULL THEN
    RAISE EXCEPTION 'board thread expiry extension requires a root id';
  END IF;
  IF p_expires_at IS NULL THEN
    RAISE EXCEPTION 'board thread expiry extension requires an expiry';
  END IF;
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'board thread expiry extension requires a signed-in user';
  END IF;
  UPDATE public.board_message root
  SET expires_at = greatest(root.expires_at, least(p_expires_at, now() + interval '7 days')),
      revision = nextval('public.board_message_revision'::regclass)
  WHERE root.id = p_root_id
    AND root.kind IN ('question', 'notice')
    AND root.expires_at IS NOT NULL
    AND root.expires_at > now()
    AND root.withdrawn_at IS NULL
    AND least(p_expires_at, now() + interval '7 days') > root.expires_at
    AND EXISTS (
      SELECT 1 FROM public.board_message reply
      WHERE reply.thread_root_id = p_root_id
        AND reply.author_user_id = actor_id
    );
  GET DIAGNOSTICS extended = ROW_COUNT;
  IF extended > 0 THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.board_message root
    WHERE root.id = p_root_id
      AND root.kind IN ('question', 'notice')
      AND root.expires_at IS NOT NULL
      AND root.expires_at > now()
      AND root.withdrawn_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.board_message reply
        WHERE reply.thread_root_id = p_root_id
          AND reply.author_user_id = actor_id
      )
  );
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.board_message_extend_thread_expiry(uuid, timestamptz) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.board_message_extend_thread_expiry(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.board_message_extend_thread_expiry(uuid, timestamptz) TO record_actor;
