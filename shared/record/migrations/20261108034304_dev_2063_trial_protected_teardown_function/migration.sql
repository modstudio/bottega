CREATE FUNCTION public.record_delete_trial_protected_space_rows(target_space_id uuid)
RETURNS TABLE(secret_dek_count bigint, routing_evidence_head_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.space s
    WHERE s.id = target_space_id
      AND jsonb_typeof(s.metadata->'trial') = 'object'
  ) THEN
    RAISE EXCEPTION 'trial-marker guard failed: space % is not a marked trial space', target_space_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.membership m
    WHERE m.space_id = target_space_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'caller-owner guard failed: current app.user_id is not an owner of space %', target_space_id
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.secret_dek WHERE space_id = target_space_id;
  GET DIAGNOSTICS secret_dek_count = ROW_COUNT;

  DELETE FROM public.routing_evidence_head WHERE space_id = target_space_id;
  GET DIAGNOSTICS routing_evidence_head_count = ROW_COUNT;

  RETURN NEXT;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION public.record_delete_trial_protected_space_rows(uuid) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_delete_trial_protected_space_rows(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_delete_trial_protected_space_rows(uuid) TO record_actor;
