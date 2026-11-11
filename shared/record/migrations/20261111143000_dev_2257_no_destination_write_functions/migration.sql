CREATE FUNCTION public.no_destination_write_retention() RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT interval '14 days'
$$;

ALTER FUNCTION public.no_destination_write_retention() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.no_destination_write_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.no_destination_write_retention() TO record_actor;

CREATE FUNCTION public.no_destination_write_window_start() RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT greatest(
    now() - public.no_destination_write_retention(),
    public.no_destination_write_coverage_start()
  )
$$;

ALTER FUNCTION public.no_destination_write_window_start() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.no_destination_write_window_start() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.no_destination_write_window_start() TO record_actor;

CREATE FUNCTION public.no_destination_write_record(
  p_route text,
  p_cause text,
  p_source text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_space_id uuid := nullif(current_setting('app.space_id', true), '')::uuid;
  actor_user_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.membership
    WHERE space_id = actor_space_id AND user_id = actor_user_id
  ) THEN
    RAISE EXCEPTION 'destination-less write recording requires space membership';
  END IF;

  INSERT INTO public.no_destination_write (id, space_id, route, cause, source, at, created_at)
  VALUES (gen_random_uuid(), actor_space_id, p_route, p_cause, p_source, now(), now());
END
$$;

ALTER FUNCTION public.no_destination_write_record(text, text, text) OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.no_destination_write_record(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.no_destination_write_record(text, text, text) TO record_actor;

CREATE OR REPLACE FUNCTION public.no_destination_write_prune() RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  batch_limit CONSTANT integer := 5000;
  deleted_count bigint;
BEGIN
  WITH expired AS (
    SELECT ctid
    FROM public.no_destination_write
    WHERE at < now() - public.no_destination_write_retention()
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
