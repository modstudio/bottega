CREATE FUNCTION record_membership_admin(target_space_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.space_id = target_space_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.role IN ('owner', 'admin')
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION record_membership_admin(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_membership_admin(uuid) TO record_actor;
