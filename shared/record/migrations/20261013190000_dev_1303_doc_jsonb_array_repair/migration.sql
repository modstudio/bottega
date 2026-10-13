CREATE FUNCTION pg_temp.dev_1303_jsonb_array(value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  parsed jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'string' THEN
    RETURN NULL;
  END IF;
  BEGIN
    parsed := (value #>> '{}')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(parsed) = 'array' THEN
    RETURN parsed;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE doc
SET source_files=pg_temp.dev_1303_jsonb_array(source_files),
    updated_at=clock_timestamp()
WHERE pg_temp.dev_1303_jsonb_array(source_files) IS NOT NULL;--> statement-breakpoint
UPDATE doc_revision
SET source_files=pg_temp.dev_1303_jsonb_array(source_files)
WHERE pg_temp.dev_1303_jsonb_array(source_files) IS NOT NULL;--> statement-breakpoint
UPDATE doc_revision
SET related_subject_ids=pg_temp.dev_1303_jsonb_array(related_subject_ids)
WHERE pg_temp.dev_1303_jsonb_array(related_subject_ids) IS NOT NULL;--> statement-breakpoint
ALTER TABLE doc FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION pg_temp.dev_1303_jsonb_array(jsonb);
