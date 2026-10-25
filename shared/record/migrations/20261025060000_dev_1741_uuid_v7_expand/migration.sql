-- Follows the record-id rule in shared/record-id.ts for trigger-written rows.
-- Calls at distinct microseconds sort by time; calls within one microsecond are not ordered.
CREATE FUNCTION public.record_uuid_v7() RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  minted_at timestamptz := clock_timestamp();
  unix_milliseconds bigint := floor(extract(epoch FROM minted_at) * 1000)::bigint;
  submillisecond_bits bigint := floor(
    (extract(microseconds FROM minted_at)::bigint % 1000) * 4096 / 1000
  )::bigint;
  uuid_bytes bytea := uuid_send(gen_random_uuid());
BEGIN
  uuid_bytes := set_byte(uuid_bytes, 0, ((unix_milliseconds >> 40) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 1, ((unix_milliseconds >> 32) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 2, ((unix_milliseconds >> 24) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 3, ((unix_milliseconds >> 16) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 4, ((unix_milliseconds >> 8) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 5, (unix_milliseconds & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 6, (112 | ((submillisecond_bits >> 8) & 15))::integer);
  uuid_bytes := set_byte(uuid_bytes, 7, (submillisecond_bits & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 8, (128 | (get_byte(uuid_bytes, 8) & 63))::integer);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$$;

ALTER FUNCTION public.record_uuid_v7() OWNER TO record_owner;
REVOKE ALL ON FUNCTION public.record_uuid_v7() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_uuid_v7() TO record_actor;

CREATE OR REPLACE FUNCTION public.hub_change_append(
  changed_space_id uuid,
  changed_table_name text,
  changed_row_id uuid,
  changed_op text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  next_sequence bigint;
BEGIN
  INSERT INTO public.hub_change_head (id, space_id, sequence)
  VALUES (public.record_uuid_v7(), changed_space_id, 1)
  ON CONFLICT (space_id) DO UPDATE
  SET sequence = hub_change_head.sequence + 1
  RETURNING sequence INTO next_sequence;

  INSERT INTO public.hub_change (id, space_id, sequence, table_name, row_id, op)
  VALUES (
    public.record_uuid_v7(),
    changed_space_id,
    next_sequence,
    changed_table_name,
    changed_row_id,
    changed_op
  );

  RETURN next_sequence;
END
$$;
