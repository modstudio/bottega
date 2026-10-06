DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public') THEN
    RAISE EXCEPTION 'dev_1130_public_role requires role record_public; create it with NOLOGIN and grant it to record_actor with INHERIT FALSE, SET TRUE before migrating';
  END IF;
END
$$;
