CREATE FUNCTION board_message_assign_revision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.revision := nextval('board_message_revision');
  RETURN NEW;
END
$$;

CREATE TRIGGER board_message_assign_revision
BEFORE INSERT OR UPDATE ON board_message
FOR EACH ROW EXECUTE FUNCTION board_message_assign_revision();

ALTER TABLE board_message FORCE ROW LEVEL SECURITY;
ALTER TABLE board_message_tag FORCE ROW LEVEL SECURITY;
ALTER TABLE board_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE board_claim FORCE ROW LEVEL SECURITY;

GRANT USAGE, SELECT ON SEQUENCE board_message_revision TO record_actor;
