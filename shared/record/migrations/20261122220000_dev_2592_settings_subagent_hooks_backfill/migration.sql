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
EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
  RETURN NULL;
END;
$$;--> statement-breakpoint
WITH backfill_revision AS (
  INSERT INTO doc_revision (
    id, space_id, doc_id, scope, subject, owner_user_id, slug, project_id, op,
    title, body, delivery, audiences, featured, status, kind, form,
    article_subject_id, source_files, checked_against_commit, summary,
    replacement_slug, parent_id, position, author, reason, at
  )
  SELECT
    gen_random_uuid(), d.space_id, d.id, d.scope, d.subject, d.owner_user_id,
    d.slug, d.project_id, 'backfill', d.title,
    jsonb_set(
      pg_temp.dev_2592_settings_body(d.body),
      '{options}',
      COALESCE(pg_temp.dev_2592_settings_body(d.body)->'options', '{}'::jsonb) || '{"subagentHooks":"on"}'::jsonb
    )::text,
    d.delivery, d.audiences, d.featured, d.status, d.kind, d.form,
    d.article_subject_id, d.source_files, d.checked_against_commit, d.summary,
    d.replacement_slug, d.parent_id, d.position, 'migration',
    'DEV-2592: subagent blocking stays on for existing users', clock_timestamp()
  FROM doc d
  WHERE d.scope='settings'
    AND pg_temp.dev_2592_settings_body(d.body) IS NOT NULL
    AND pg_temp.dev_2592_settings_body(d.body)->'options'->>'subagentHooks' IS DISTINCT FROM 'on'
  RETURNING id, doc_id, body
)
UPDATE doc d
SET body=backfill_revision.body,
    updated_at=clock_timestamp(),
    latest_revision_id=backfill_revision.id
FROM backfill_revision
WHERE d.id=backfill_revision.doc_id;--> statement-breakpoint
ALTER TABLE doc FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION pg_temp.dev_2592_settings_body(text);
