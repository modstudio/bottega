CREATE FUNCTION board_message_assign_revision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.revision := nextval('board_message_revision');
  RETURN NEW;
END
$$;

CREATE TRIGGER board_message_assign_revision
BEFORE INSERT OR UPDATE ON "board_message"
FOR EACH ROW EXECUTE FUNCTION board_message_assign_revision();

CREATE FUNCTION board_message_validate_reply() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  root_scope_project_ids uuid[];
  root_recipient_user_ids uuid[];
BEGIN
  IF NEW.kind = 'reply' THEN
    SELECT scope_project_ids, recipient_user_ids
      INTO root_scope_project_ids, root_recipient_user_ids
      FROM board_message
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
FOR EACH ROW EXECUTE FUNCTION board_message_validate_reply();

ALTER TABLE "board_message" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_message_tag" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_receipt" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_claim" FORCE ROW LEVEL SECURITY;

GRANT USAGE, SELECT ON SEQUENCE board_message_revision TO record_actor;
