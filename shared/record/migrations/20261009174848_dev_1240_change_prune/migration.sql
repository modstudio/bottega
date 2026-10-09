CREATE FUNCTION public.hub_change_prune(retention interval) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  IF retention IS NULL OR retention < interval '1 day' THEN
    RAISE EXCEPTION 'hub change retention must be at least one day; pass an interval of one day or longer';
  END IF;

  DELETE FROM public.hub_change
  WHERE at < now() - retention;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.hub_change_prune(interval) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.hub_change_prune(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_change_prune(interval) TO record_actor;
