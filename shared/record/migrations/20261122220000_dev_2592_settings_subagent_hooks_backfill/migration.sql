ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.dev_2592_settings_body(input text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  parsed jsonb;
BEGIN
  parsed := input::jsonb;
  IF jsonb_typeof(parsed) <> 'object'
    OR (parsed ? 'options' AND jsonb_typeof(parsed->'options') <> 'object') THEN
    RETURN NULL;
  END IF;
  RETURN parsed;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;--> statement-breakpoint
UPDATE doc
SET body=jsonb_set(
      pg_temp.dev_2592_settings_body(body),
      '{options}',
      COALESCE(pg_temp.dev_2592_settings_body(body)->'options', '{}'::jsonb) || '{"subagentHooks":"on"}'::jsonb
    )::text,
    updated_at=clock_timestamp()
WHERE scope='settings'
  AND pg_temp.dev_2592_settings_body(body) IS NOT NULL
  AND pg_temp.dev_2592_settings_body(body)->'options'->>'subagentHooks' IS DISTINCT FROM 'on';--> statement-breakpoint
UPDATE doc_revision
SET body=jsonb_set(
      pg_temp.dev_2592_settings_body(body),
      '{options}',
      COALESCE(pg_temp.dev_2592_settings_body(body)->'options', '{}'::jsonb) || '{"subagentHooks":"on"}'::jsonb
    )::text
WHERE scope='settings'
  AND pg_temp.dev_2592_settings_body(body) IS NOT NULL
  AND pg_temp.dev_2592_settings_body(body)->'options'->>'subagentHooks' IS DISTINCT FROM 'on';--> statement-breakpoint
DROP FUNCTION pg_temp.dev_2592_settings_body(text);--> statement-breakpoint
ALTER TABLE doc FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
