CREATE FUNCTION record_config_access_stranded_dek_versions(target_space uuid, target_user uuid)
RETURNS TABLE(version integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT DISTINCT d.version
  FROM config_secret s
  JOIN secret_dek d ON d.space_id=s.space_id AND d.id=s.dek_id
  WHERE s.space_id=target_space
    AND EXISTS (
      SELECT 1
      FROM secret_dek_wrap w
      JOIN machine_public_key k
        ON k.space_id=w.space_id AND k.key_id=w.recipient_key_id
      JOIN membership m
        ON m.space_id=k.space_id AND m.user_id=k.user_id
      WHERE w.space_id=s.space_id AND w.dek_id=s.dek_id
        AND k.revoked_at IS NULL AND m.config_access
        AND m.user_id=target_user
    )
    AND NOT EXISTS (
      SELECT 1
      FROM secret_dek_wrap w
      JOIN machine_public_key k
        ON k.space_id=w.space_id AND k.key_id=w.recipient_key_id
      JOIN membership m
        ON m.space_id=k.space_id AND m.user_id=k.user_id
      WHERE w.space_id=s.space_id AND w.dek_id=s.dek_id
        AND k.revoked_at IS NULL AND m.config_access
        AND m.user_id<>target_user
    )
  ORDER BY d.version
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_config_access_stranded_dek_versions(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_config_access_stranded_dek_versions(uuid, uuid) TO record_actor;
--> statement-breakpoint
CREATE FUNCTION record_revoke_member_config_machines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  stranded_versions text;
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.config_access)
    OR (TG_OP = 'UPDATE' AND OLD.config_access AND NOT NEW.config_access) THEN
    SELECT string_agg(version::text, ', ' ORDER BY version)
    INTO stranded_versions
    FROM record_config_access_stranded_dek_versions(OLD.space_id, OLD.user_id);

    IF stranded_versions IS NOT NULL THEN
      -- Keep this refusal and remedy in sync with orchestrator/src/record/record-config-access-removal.ts.
      RAISE EXCEPTION 'cannot remove config access because it would strand data key versions: %; from one of the member''s machines, trust a machine of a remaining config-access holder with `bottega machine config machine trust <keyId> <publicKey>` so the data key is wrapped for it, then retry', stranded_versions;
    END IF;

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
BEFORE DELETE OR UPDATE OF config_access ON membership
FOR EACH ROW EXECUTE FUNCTION record_revoke_member_config_machines();
