DO $$
DECLARE
  revoke_memberships text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public') THEN
    RAISE EXCEPTION 'dev_1130_public_role requires role record_public. Clear with: CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public' AND rolcanlogin) THEN
    RAISE EXCEPTION 'dev_1130_public_role requires record_public to have NOLOGIN. Clear with: ALTER ROLE record_public NOLOGIN;';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public' AND rolsuper) THEN
    RAISE EXCEPTION 'dev_1130_public_role requires record_public to have NOSUPERUSER. Clear with: ALTER ROLE record_public NOSUPERUSER;';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'record_public' AND rolbypassrls) THEN
    RAISE EXCEPTION 'dev_1130_public_role requires record_public to have NOBYPASSRLS. Clear with: ALTER ROLE record_public NOBYPASSRLS;';
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname = 'record_public' AND (rolcreaterole OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'record_public must not create roles, create databases or replicate, because SET ROLE confers those attributes. Clear with: ALTER ROLE record_public NOCREATEROLE NOCREATEDB NOREPLICATION;';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'record_public'
      AND member_role.rolname = 'record_actor'
      AND membership.inherit_option = false
      AND membership.set_option = true
  ) THEN
    RAISE EXCEPTION 'dev_1130_public_role requires record_actor membership in record_public with INHERIT FALSE and SET TRUE. Clear with: GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE granted_role.rolname = 'record_public'
      AND membership.inherit_option
  ) THEN
    RAISE EXCEPTION 'record_public must not be inherited by any member, because its policy would then apply to that member''s ordinary queries. Clear with: REVOKE record_public FROM <member>; then GRANT record_public TO <member> WITH INHERIT FALSE;';
  END IF;
  SELECT string_agg(format('REVOKE %I FROM record_public;', granted_role.rolname), ' ')
  INTO revoke_memberships
  FROM pg_auth_members membership
  JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
  JOIN pg_roles member_role ON member_role.oid = membership.member
  WHERE member_role.rolname = 'record_public';
  IF revoke_memberships IS NOT NULL THEN
    RAISE EXCEPTION 'dev_1130_public_role requires record_public to be a member of no role. Clear with: %', revoke_memberships;
  END IF;
END
$$;
