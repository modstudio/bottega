ALTER TABLE public.hub_applied_change FORCE ROW LEVEL SECURITY;

ALTER TABLE public.hub_applied_change ADD CONSTRAINT "hub_applied_change_result_not_json_string_check" CHECK (jsonb_typeof("result") <> 'string') NOT VALID;
ALTER TABLE "hub_applied_change" VALIDATE CONSTRAINT "hub_applied_change_result_not_json_string_check";

DO $migration$
DECLARE
  definition text;
  previous text := '(''hub_day'',''space''),';
  replacement text := '(''hub_applied_change'',''space''),(''hub_day'',''space''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space hub_day classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;

CREATE FUNCTION public.hub_applied_change_prune(retention_days integer) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM public.hub_applied_change
  WHERE applied_at < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.hub_applied_change_prune(integer) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.hub_applied_change_prune(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_applied_change_prune(integer) TO record_actor;
