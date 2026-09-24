CREATE FUNCTION hub_report_email_recipient(token text)
RETURNS TABLE(email text, subscription text, space text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.email, s.cadence || ' report', sp.name
  FROM hub_report_subscription_recipient r
  JOIN hub_report_subscription s ON s.id = r.subscription_id
  JOIN space sp ON sp.id = r.space_id
  WHERE r.unsubscribe_token = token AND s.deleted_at IS NULL
$$;

CREATE FUNCTION hub_unsubscribe_report_email_recipient(token text)
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM hub_report_subscription_recipient r
  WHERE r.unsubscribe_token = token
  RETURNING r.id
$$;

REVOKE ALL ON FUNCTION hub_report_email_recipient(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_unsubscribe_report_email_recipient(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_report_email_recipient(text) TO record_actor;
GRANT EXECUTE ON FUNCTION hub_unsubscribe_report_email_recipient(text) TO record_actor;
