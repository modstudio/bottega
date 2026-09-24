DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_auth') THEN
    RAISE EXCEPTION 'dev_899_auth_role requires role record_auth; create it before migrating';
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO record_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "user" TO record_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  session, account, verification, space, membership, invitation
TO record_auth;
