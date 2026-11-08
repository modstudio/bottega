ALTER TABLE config_secret NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM config_secret
    WHERE provider IS NOT NULL
      AND key <> provider || '/' || CASE WHEN name IS NULL THEN '' ELSE name || '/' END || type || '#' || mode || '@' || environment
  ) THEN
    RAISE EXCEPTION 'credential rows use the former derived key; delete and recreate each one with `bottega credential delete ...` then `bottega credential set ...` before migrating';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE config_secret FORCE ROW LEVEL SECURITY;
