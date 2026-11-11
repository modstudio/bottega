CREATE POLICY "machine_name_claim_owner_delete" ON "machine_name_claim" AS PERMISSIVE FOR DELETE TO "record_owner" USING ("machine_name_claim"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_owner_delete" ON "hub_send" AS PERMISSIVE FOR DELETE TO "record_owner" USING ("hub_send"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hub_send_recipient_owner_delete" ON "hub_send_recipient" AS PERMISSIVE FOR DELETE TO "record_owner" USING ("hub_send_recipient"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_outside_write_owner_select" ON "space_outside_write" AS PERMISSIVE FOR SELECT TO "record_owner" USING ("space_outside_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "space_outside_write_owner_delete" ON "space_outside_write" AS PERMISSIVE FOR DELETE TO "record_owner" USING ("space_outside_write"."space_id" = nullif(current_setting('app.space_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION public.record_delete_append_only_space_rows(target_space_id uuid)
RETURNS TABLE(
  hub_send_recipient_count bigint,
  hub_send_count bigint,
  space_outside_write_count bigint,
  machine_name_claim_count bigint,
  board_presence_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
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
CREATE FUNCTION public.record_delete_append_only_project_rows(target_project_id uuid)
RETURNS TABLE(
  hub_send_recipient_count bigint,
  hub_send_count bigint,
  board_presence_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target_space_id uuid;
BEGIN
  SELECT p.space_id
  INTO target_space_id
  FROM public.project p
  WHERE p.id = target_project_id;

  IF target_space_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.membership m
    WHERE m.space_id = target_space_id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'caller-owner guard failed: current app.user_id is not an owner of project % space', target_project_id
      USING ERRCODE = '42501';
  END IF;

  IF nullif(current_setting('app.space_id', true), '')::uuid IS DISTINCT FROM target_space_id THEN
    RAISE EXCEPTION 'tenant-binding guard failed: app.space_id is not space %', target_space_id
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.hub_send_recipient
  WHERE send_id IN (
    SELECT hs.id
    FROM public.hub_send hs
    JOIN public.hub_report_subscription hrs ON hrs.id = hs.subscription_id
    WHERE hrs.project_id = target_project_id
  );
  GET DIAGNOSTICS hub_send_recipient_count = ROW_COUNT;

  DELETE FROM public.hub_send
  WHERE subscription_id IN (
    SELECT hrs.id
    FROM public.hub_report_subscription hrs
    WHERE hrs.project_id = target_project_id
  );
  GET DIAGNOSTICS hub_send_count = ROW_COUNT;

  DELETE FROM public.board_presence WHERE project_id = target_project_id;
  GET DIAGNOSTICS board_presence_count = ROW_COUNT;

  RETURN NEXT;
END
$function$;
--> statement-breakpoint
ALTER FUNCTION public.record_delete_append_only_project_rows(uuid) OWNER TO record_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_delete_append_only_project_rows(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_delete_append_only_project_rows(uuid) TO record_actor;
