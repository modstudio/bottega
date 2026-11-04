CREATE FUNCTION record_revoke_member_config_machines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.config_access AND NOT NEW.config_access) THEN
    DELETE FROM secret_dek_wrap w
    USING machine_public_key k
    WHERE k.space_id=OLD.space_id
      AND k.user_id=OLD.user_id
      AND k.revoked_at IS NULL
      AND w.space_id=k.space_id
      AND w.recipient_key_id=k.key_id;

    UPDATE machine_public_key
    SET revoked_at=now()
    WHERE space_id=OLD.space_id
      AND user_id=OLD.user_id
      AND revoked_at IS NULL;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER membership_revoke_config_machines
AFTER DELETE OR UPDATE OF config_access ON membership
FOR EACH ROW EXECUTE FUNCTION record_revoke_member_config_machines();
