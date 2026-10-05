ALTER TABLE public.board_claim
ALTER CONSTRAINT board_claim_superseded_by_claim_id_board_claim_id_fkey
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.board_message_assign_revision() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.revision := nextval('public.board_message_revision'::regclass);
  RETURN NEW;
END
$$;

CREATE TRIGGER board_message_assign_revision
BEFORE INSERT OR UPDATE ON "board_message"
FOR EACH ROW EXECUTE FUNCTION public.board_message_assign_revision();

CREATE FUNCTION public.board_message_validate_reply() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  root_scope_project_ids uuid[];
  root_recipient_user_ids uuid[];
BEGIN
  IF NEW.kind = 'reply' THEN
    SELECT scope_project_ids, recipient_user_ids
      INTO root_scope_project_ids, root_recipient_user_ids
      FROM public.board_message
      WHERE id = NEW.thread_root_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'board reply thread root is not visible';
    END IF;

    IF root_scope_project_ids <> NEW.scope_project_ids
      OR root_recipient_user_ids <> NEW.recipient_user_ids THEN
      RAISE EXCEPTION 'board reply scope and recipients must match thread root';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER board_message_validate_reply
BEFORE INSERT OR UPDATE ON "board_message"
FOR EACH ROW EXECUTE FUNCTION public.board_message_validate_reply();

CREATE FUNCTION public.board_claim_validate_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.holder_user_id IS DISTINCT FROM OLD.holder_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
    OR NEW.subject_value IS DISTINCT FROM OLD.subject_value THEN
    RAISE EXCEPTION 'board claim identity and holder cannot change';
  END IF;

  IF OLD.holder_user_id = nullif(current_setting('app.user_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;

  IF OLD.closed_at IS NOT NULL OR OLD.lapses_at > CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'only its holder may update a live board claim';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.holder_session IS DISTINCT FROM OLD.holder_session
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
    OR NEW.taken_at IS DISTINCT FROM OLD.taken_at
    OR NEW.renewed_at IS DISTINCT FROM OLD.renewed_at
    OR NEW.lapses_at IS DISTINCT FROM OLD.lapses_at THEN
    RAISE EXCEPTION 'a non-holder may only close or supersede a lapsed board claim';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER board_claim_validate_update
BEFORE UPDATE ON "board_claim"
FOR EACH ROW EXECUTE FUNCTION public.board_claim_validate_update();

ALTER TABLE "board_message" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_message_tag" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_receipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_claim" FORCE ROW LEVEL SECURITY;

GRANT USAGE, SELECT ON SEQUENCE public.board_message_revision TO record_actor;
