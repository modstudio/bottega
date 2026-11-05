CREATE OR REPLACE FUNCTION public.record_change_log_row() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  row_id_column text := COALESCE(TG_ARGV[0], 'id');
  logged_table text := COALESCE(TG_ARGV[1], TG_TABLE_NAME);
  old_space uuid;
  new_space uuid;
  old_id uuid;
  new_id uuid;
  logged boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  old_space := (old_row->>'space_id')::uuid;
  new_space := (new_row->>'space_id')::uuid;
  old_id := (old_row->>row_id_column)::uuid;
  new_id := (new_row->>row_id_column)::uuid;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.record_change (space_id,table_name,row_id,op)
    VALUES (new_space,logged_table,new_id,'upsert');
    logged := true;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.record_change (space_id,table_name,row_id,op)
    VALUES (old_space,logged_table,old_id,CASE WHEN TG_NARGS > 1 THEN 'upsert' ELSE 'delete' END);
    logged := true;
  ELSIF OLD IS DISTINCT FROM NEW THEN
    IF old_space IS DISTINCT FROM new_space OR old_id IS DISTINCT FROM new_id THEN
      INSERT INTO public.record_change (space_id,table_name,row_id,op)
      VALUES (
        old_space,
        logged_table,
        old_id,
        CASE
          WHEN old_space IS DISTINCT FROM new_space THEN 'delete'
          WHEN TG_NARGS > 1 THEN 'upsert'
          ELSE 'delete'
        END
      );
    END IF;
    INSERT INTO public.record_change (space_id,table_name,row_id,op)
    VALUES (new_space,logged_table,new_id,'upsert');
    logged := true;
  END IF;
  IF logged THEN PERFORM pg_notify('record_change_advanced',''); END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
