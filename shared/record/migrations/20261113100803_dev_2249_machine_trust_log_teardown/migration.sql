DROP FUNCTION public.record_delete_append_only_space_rows(uuid);
--> statement-breakpoint
CREATE FUNCTION public.record_delete_append_only_space_rows(target_space_id uuid)
RETURNS TABLE(
  hub_send_recipient_count bigint,
  hub_send_count bigint,
  space_outside_write_count bigint,
  machine_name_claim_count bigint,
  board_presence_count bigint,
  machine_trust_log_count bigint
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
  RETURN NEXT;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION public.record_delete_append_only_space_rows(uuid) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_delete_append_only_space_rows(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_delete_append_only_space_rows(uuid) TO record_actor;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  revised text;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  revised := replace(
    definition,
    '(''machine_public_key'',''space''),',
    '(''machine_public_key'',''space''),(''machine_trust_log'',''space''),'
  );
  IF revised = definition THEN
    RAISE EXCEPTION 'record_move_project_space machine_public_key classification anchor is missing';
  END IF;
  EXECUTE revised;
END
$migration$;
