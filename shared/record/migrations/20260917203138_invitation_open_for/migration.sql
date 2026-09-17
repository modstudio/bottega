-- The sign-up gate must answer before any tenant context exists, so the owner may read invitations.
CREATE POLICY "invitation_owner_signup_select" ON "invitation"
AS PERMISSIVE FOR SELECT TO record_owner USING (true);--> statement-breakpoint

CREATE FUNCTION public.invitation_open_for(candidate_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.invitation
    WHERE lower(btrim(email)) = lower(btrim(candidate_email))
      AND status = 'pending'
      AND expires_at > CURRENT_TIMESTAMP
  );
$function$;--> statement-breakpoint

ALTER FUNCTION public.invitation_open_for(text) OWNER TO record_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.invitation_open_for(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.invitation_open_for(text) TO record_actor, record_owner;
