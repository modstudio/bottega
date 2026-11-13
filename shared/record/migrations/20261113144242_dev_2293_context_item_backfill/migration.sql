-- DEV-2293: migrate hosted context documents before the following contract migration.
ALTER TABLE "doc" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "doc_revision" NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
WITH parsed AS (
  SELECT
    id,
    space_id,
    split_part(subject, ':', 1) AS holder_kind,
    substring(subject FROM position(':' IN subject) + 1) AS holder_id,
    slug,
    (((regexp_match(body, E'(?m)^kind:\\s*(.+)$'))[1])::jsonb #>> '{}') AS context_kind,
    (((regexp_match(body, E'(?m)^source:\\s*(.+)$'))[1])::jsonb #>> '{}') AS context_source,
    CASE WHEN body ~ E'(?m)^objection:\\s*'
      THEN (((regexp_match(body, E'(?m)^objection:\\s*(.+)$'))[1])::jsonb #>> '{}')
    END AS objection,
    substring(
      body FROM position(E'\n---\n' IN substring(body FROM 5)) + 9
    ) AS context_body,
    created_at,
    updated_at
  FROM doc
  WHERE scope = 'context'
)
INSERT INTO context_item(
  id, space_id, holder_kind, holder_id, slug, kind, body, source,
  question_number, target, created_at, updated_at
)
SELECT
  id, space_id, holder_kind, holder_id, slug, context_kind,
  context_body || CASE WHEN objection IS NULL THEN '' ELSE E'\n\nOverrode: ' || objection END,
  context_source,
  CASE WHEN context_kind IN ('ruling','position') AND context_source ~ '^q[0-9]+$'
    THEN substring(context_source FROM 2)::integer
  END,
  CASE WHEN context_kind = 'pointer' THEN btrim(context_body) END,
  created_at, updated_at
FROM parsed
ON CONFLICT (space_id, holder_kind, holder_id, slug) DO NOTHING;
--> statement-breakpoint
DELETE FROM doc_revision WHERE scope = 'context';
--> statement-breakpoint
DELETE FROM doc WHERE scope = 'context';
--> statement-breakpoint
ALTER TABLE "doc_revision" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "doc" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "context_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $migration$
DECLARE
  definition text;
  previous text := '(''config_entry'',''space''),';
  replacement text := '(''config_entry'',''space''),(''context_item'',''space''),';
BEGIN
  SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure)
  INTO definition;
  IF position(previous IN definition) = 0 THEN
    RAISE EXCEPTION 'record_move_project_space config_entry classification anchor is missing';
  END IF;
  EXECUTE replace(definition, previous, replacement);
END
$migration$;
