ALTER TABLE config_secret NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  repairs text;
BEGIN
  SELECT string_agg(
    format(
      '%s (run `bottega machine config secret delete %s%s`, then `bottega credential set ...`)',
      key,
      key,
      CASE WHEN user_id IS NULL THEN ' --space' ELSE '' END
    ),
    ', ' ORDER BY key
  )
  INTO repairs
  FROM config_secret
  WHERE provider IS NOT NULL
    AND key <> provider || '/' || CASE WHEN name IS NULL THEN '' ELSE name || '/' END || type || '#' || mode || '@' || environment;

  IF repairs IS NOT NULL THEN
    RAISE EXCEPTION 'credential rows use former derived keys: %', repairs;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE config_secret FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "config_secret" ADD CONSTRAINT "config_secret_credential_identity_key_check" CHECK ("provider" IS NULL OR "key" = "provider" || '/' || CASE WHEN "name" IS NULL THEN '' ELSE "name" || '/' END || "type" || '#' || "mode" || '@' || "environment");
