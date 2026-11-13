ALTER TABLE public.machine_join_nameplate FORCE ROW LEVEL SECURITY;
ALTER TABLE public.machine_join_message FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION public.machine_join_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  retention CONSTANT interval := interval '1 hour';
  deleted_count bigint;
BEGIN
  WITH deleted AS (
    DELETE FROM public.machine_join_nameplate
    WHERE created_at < now() - retention
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END
$$;
ALTER FUNCTION public.machine_join_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.machine_join_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.machine_join_prune() TO record_actor;
--> statement-breakpoint
CREATE FUNCTION public.machine_key_claim_challenge_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  WITH deleted AS (
    DELETE FROM public.machine_key_claim_challenge
    WHERE expires_at < now()
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END
$$;
ALTER FUNCTION public.machine_key_claim_challenge_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.machine_key_claim_challenge_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.machine_key_claim_challenge_prune() TO record_actor;
--> statement-breakpoint
DROP FUNCTION public.record_delete_append_only_space_rows(uuid);
--> statement-breakpoint
CREATE FUNCTION public.record_delete_append_only_space_rows(target_space_id uuid)
RETURNS TABLE(
  hub_send_recipient_count bigint,
  hub_send_count bigint,
  space_outside_write_count bigint,
  machine_name_claim_count bigint,
  board_presence_count bigint,
  machine_trust_log_count bigint,
  machine_join_message_count bigint,
  machine_join_nameplate_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.membership m
    WHERE m.space_id = target_space_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'caller-owner guard failed: current app.user_id is not an owner of space %', target_space_id
      USING ERRCODE = '42501';
  END IF;
  IF nullif(current_setting('app.space_id', true), '')::uuid IS DISTINCT FROM target_space_id THEN
    RAISE EXCEPTION 'tenant-binding guard failed: app.space_id is not space %', target_space_id
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.hub_send_recipient WHERE space_id = target_space_id;
  GET DIAGNOSTICS hub_send_recipient_count = ROW_COUNT;
  DELETE FROM public.hub_send WHERE space_id = target_space_id;
  GET DIAGNOSTICS hub_send_count = ROW_COUNT;
  DELETE FROM public.space_outside_write WHERE space_id = target_space_id;
  GET DIAGNOSTICS space_outside_write_count = ROW_COUNT;
  DELETE FROM public.machine_name_claim WHERE space_id = target_space_id;
  GET DIAGNOSTICS machine_name_claim_count = ROW_COUNT;
  DELETE FROM public.board_presence WHERE space_id = target_space_id;
  GET DIAGNOSTICS board_presence_count = ROW_COUNT;
  DELETE FROM public.machine_trust_log WHERE space_id = target_space_id;
  GET DIAGNOSTICS machine_trust_log_count = ROW_COUNT;
  DELETE FROM public.machine_join_message WHERE space_id = target_space_id;
  GET DIAGNOSTICS machine_join_message_count = ROW_COUNT;
  DELETE FROM public.machine_join_nameplate WHERE space_id = target_space_id;
  GET DIAGNOSTICS machine_join_nameplate_count = ROW_COUNT;
  RETURN NEXT;
END
$function$;
ALTER FUNCTION public.record_delete_append_only_space_rows(uuid) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.record_delete_append_only_space_rows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_delete_append_only_space_rows(uuid) TO record_actor;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous text := '(''machine_trust_log'',''space''),';
  replacement text := '(''machine_trust_log'',''space''),(''machine_join_nameplate'',''space''),(''machine_join_message'',''space''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space machine_trust_log classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
