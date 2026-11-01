-- BACKFILL
UPDATE question AS filing
SET filed_record_id = (
  SELECT revision.record_id
  FROM doc_revision AS revision
  WHERE filing.filed_ref LIKE '%@' || revision.record_id
     OR filing.filed_ref = revision.scope || '/' || COALESCE(revision.subject, '_') || '/' || revision.slug || '@' || revision.number
)
WHERE filing.filed_as = 'doc'
  AND filing.filed_record_id IS NULL
  AND (
    SELECT COUNT(*)
    FROM doc_revision AS revision
    WHERE filing.filed_ref LIKE '%@' || revision.record_id
       OR filing.filed_ref = revision.scope || '/' || COALESCE(revision.subject, '_') || '/' || revision.slug || '@' || revision.number
  ) = 1;
-- /BACKFILL
