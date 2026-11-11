ALTER TABLE public.no_destination_write FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.no_destination_write_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- Matches contention's raw telemetry retention window.
  -- Changing this hosted window requires a new record migration.
  retention CONSTANT interval := interval '14 days';
  batch_limit CONSTANT integer := 5000;
  deleted_count bigint;
BEGIN
  WITH expired AS (
    SELECT ctid
    FROM public.no_destination_write
    WHERE at < now() - retention
    ORDER BY at, id
    LIMIT batch_limit
  ), deleted AS (
    DELETE FROM public.no_destination_write
    WHERE ctid IN (SELECT ctid FROM expired)
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.no_destination_write_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.no_destination_write_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.no_destination_write_prune() TO record_actor;

DO $migration$
DECLARE
  definition text;
  previous_classification text := $anchor$('contention','parent')$anchor$;
  replacement_classification text := $anchor$('contention','parent'),('no_destination_write','space')$anchor$;
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
    INTO definition;
  IF position(previous_classification IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space contention classification anchor is absent';
  END IF;
  EXECUTE replace(definition, previous_classification, replacement_classification);
END
$migration$;
