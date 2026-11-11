DO $migration$
BEGIN
  EXECUTE format(
    $create$
      CREATE FUNCTION public.no_destination_write_coverage_start() RETURNS timestamptz
      LANGUAGE sql
      IMMUTABLE
      AS $function$
        SELECT %L::timestamptz
      $function$
    $create$,
    now()
  );
END
$migration$;

ALTER FUNCTION public.no_destination_write_coverage_start() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.no_destination_write_coverage_start() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.no_destination_write_coverage_start() TO record_actor;
COMMENT ON FUNCTION public.no_destination_write_coverage_start() IS
  'Returns when destination-less write recording began so reports do not claim an earlier observation window.';
