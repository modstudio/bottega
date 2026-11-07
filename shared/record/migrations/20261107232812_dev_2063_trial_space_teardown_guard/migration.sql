CREATE FUNCTION record_user_has_real_space_membership(target_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM membership m
    JOIN "user" u ON u.id=m.user_id
    JOIN space s ON s.id=m.space_id
    WHERE m.user_id=target_user
      AND m.space_id IS DISTINCT FROM u.personal_space_id
      AND NOT (COALESCE(s.metadata, '{}'::jsonb) ? 'trial')
  )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_user_has_real_space_membership(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_user_has_real_space_membership(uuid) TO record_actor;
