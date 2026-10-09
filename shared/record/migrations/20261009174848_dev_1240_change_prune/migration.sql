CREATE FUNCTION public.hub_change_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM public.hub_change
  WHERE at < now() - interval '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

ALTER FUNCTION public.hub_change_prune() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.hub_change_prune() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_change_prune() TO record_actor;
