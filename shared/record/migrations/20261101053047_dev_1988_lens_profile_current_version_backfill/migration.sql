ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE
  filled_profiles bigint;
  profiles_without_id bigint;
BEGIN
  UPDATE lens_profile
  SET current_version_id = gen_random_uuid()
  WHERE current_version_id IS NULL;
  GET DIAGNOSTICS filled_profiles = ROW_COUNT;

  SELECT count(*) INTO profiles_without_id
  FROM lens_profile
  WHERE current_version_id IS NULL;

  RAISE NOTICE 'DEV-1988 lens profile current version ids: filled=%, remaining_null=%',
    filled_profiles, profiles_without_id;

  IF profiles_without_id <> 0 THEN
    RAISE EXCEPTION 'DEV-1988 left % lens profiles without current version ids',
      profiles_without_id;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
