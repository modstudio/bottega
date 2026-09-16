DO $$
DECLARE
  required_role text;
  public_owner text;
BEGIN
  FOREACH required_role IN ARRAY ARRAY['record_owner', 'record_actor', 'record_reader']
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = required_role) THEN
      RAISE EXCEPTION 'record_grants requires role %; create it before migrating', required_role;
    END IF;
  END LOOP;

  SELECT pg_get_userbyid(nspowner)
    INTO public_owner
    FROM pg_namespace
   WHERE nspname = 'public';
  IF public_owner IS DISTINCT FROM 'record_owner' THEN
    RAISE EXCEPTION 'record_grants requires schema public to be owned by record_owner; run ALTER SCHEMA public OWNER TO record_owner';
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

GRANT USAGE, CREATE ON SCHEMA public TO record_owner;
GRANT USAGE ON SCHEMA public TO record_actor, record_reader;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  space, membership, project, seq, run, review, review_lens, review_finding,
  landing, landing_override, landing_review_carry, contention, test_flake
TO record_actor;
GRANT SELECT ON TABLE
  space, membership, project, seq, run, review, review_lens, review_finding,
  landing, landing_override, landing_review_carry, contention, test_flake
TO record_reader;

-- Machine and user are user-scoped rather than space-scoped. Sync may upsert its machine
-- but cannot delete one or change a user; reporting may read both.
GRANT SELECT, INSERT, UPDATE ON TABLE machine TO record_actor;
GRANT SELECT ON TABLE "user" TO record_actor;
GRANT SELECT ON TABLE machine, "user" TO record_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE record_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE record_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO record_actor;
ALTER DEFAULT PRIVILEGES FOR ROLE record_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO record_reader;
