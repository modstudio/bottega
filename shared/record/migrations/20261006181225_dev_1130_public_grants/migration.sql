DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public') THEN
    RAISE EXCEPTION 'dev_1130_public_grants requires role record_public; create it with NOLOGIN and grant it to record_actor with INHERIT FALSE, SET TRUE before migrating';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO record_public;

REVOKE ALL ON TABLE public_doc_space FROM record_actor, record_reader;
GRANT SELECT ON TABLE public_doc_space TO record_actor, record_public;

REVOKE ALL ON TABLE doc FROM record_public;
GRANT SELECT (
  id, space_id, scope, subject, owner_user_id, slug, title, body, audience,
  parent_id, position, updated_at, deleted_at, search_vector
) ON TABLE doc TO record_public;
