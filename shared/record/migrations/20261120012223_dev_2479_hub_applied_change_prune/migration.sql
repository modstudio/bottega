ALTER TABLE public.hub_applied_change FORCE ROW LEVEL SECURITY;

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
