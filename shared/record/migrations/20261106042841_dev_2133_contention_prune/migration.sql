CREATE FUNCTION public.contention_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- Matches local CONTENTION_RAW_WINDOW_MS: two DEFAULT_EFFICIENCY_WINDOW_MS windows.
  -- Changing this hosted window requires a new record migration.
  retention CONSTANT interval := interval '14 days';
  batch_limit CONSTANT integer := 5000;
  deleted_count bigint;
BEGIN
  WITH expired AS (
    SELECT ctid
    FROM public.contention
    WHERE at < now() - retention
    ORDER BY at, id
    LIMIT batch_limit
  ), deleted AS (
    DELETE FROM public.contention
    WHERE ctid IN (SELECT ctid FROM expired)
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.contention_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.contention_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contention_prune() TO record_actor;
