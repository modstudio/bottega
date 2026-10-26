CREATE POLICY "board_message_owner_select" ON "board_message" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
CREATE POLICY "board_message_owner_update" ON "board_message" AS PERMISSIVE FOR UPDATE TO "record_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "board_receipt_owner_select" ON "board_receipt" AS PERMISSIVE FOR SELECT TO "record_owner" USING (true);--> statement-breakpoint
-- A reader's acknowledgement changes only its board_receipt row, and board_message_actor_update
-- admits the author alone, so the change feed cannot see the acknowledgement. This definer
-- function performs the one write a reader needs: the message's revision, and nothing else.
-- It runs as the table owner, which FORCE ROW LEVEL SECURITY applies to as well; the three owner
-- policies above are the whole of its access, and it never turns forcing off.
CREATE OR REPLACE FUNCTION public.board_message_advance_receipt_revision(p_message_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  bumped bigint := 0;
BEGIN
  IF p_message_id IS NULL THEN
    RAISE EXCEPTION 'board receipt revision advance requires a board message id';
  END IF;
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'board receipt revision advance requires a signed-in user';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.board_receipt r
    WHERE r.message_id = p_message_id
      AND r.reader_user_id = actor_id
      AND r.acknowledged_at IS NOT NULL
  ) THEN
    UPDATE public.board_message m
    SET revision = nextval('public.board_message_revision'::regclass)
    WHERE m.id = p_message_id;
    GET DIAGNOSTICS bumped = ROW_COUNT;
  END IF;
  RETURN bumped > 0;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.board_message_advance_receipt_revision(uuid) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.board_message_advance_receipt_revision(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.board_message_advance_receipt_revision(uuid) TO record_actor;
