-- BACKFILL
-- Revisions written before authorship defaulted to the signed-in user. The cutoff keeps this
-- re-executed block from rewriting an author recorded after that.
UPDATE doc_revision
SET author = (
  SELECT CASE
    WHEN json_valid(value) THEN json_extract(value, '$.id')
    ELSE NULL
  END
  FROM schema_meta
  WHERE key = 'record_signed_in_user'
)
WHERE author <> 'migration'
  AND at < '2026-10-13T02:00:00.000Z'
  AND author <> (
    SELECT CASE
      WHEN json_valid(value) THEN json_extract(value, '$.id')
      ELSE NULL
    END
    FROM schema_meta
    WHERE key = 'record_signed_in_user'
  );
-- /BACKFILL
