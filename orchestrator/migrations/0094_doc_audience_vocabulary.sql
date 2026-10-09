-- BACKFILL: Retire the ambiguous user audience without inventing a local public designation.
UPDATE doc
SET audiences = (
  SELECT json_group_array(mapped)
  FROM (
    SELECT CASE value WHEN 'user' THEN 'internal' ELSE value END AS mapped
    FROM json_each(doc.audiences)
    GROUP BY CASE value WHEN 'user' THEN 'internal' ELSE value END
    ORDER BY min(key)
  )
)
WHERE EXISTS (SELECT 1 FROM json_each(doc.audiences) WHERE value = 'user');
--> statement-breakpoint
-- BACKFILL: Revision history follows the same local-only rule and retains array order.
UPDATE doc_revision
SET audiences = (
  SELECT json_group_array(mapped)
  FROM (
    SELECT CASE value WHEN 'user' THEN 'internal' ELSE value END AS mapped
    FROM json_each(doc_revision.audiences)
    GROUP BY CASE value WHEN 'user' THEN 'internal' ELSE value END
    ORDER BY min(key)
  )
)
WHERE EXISTS (SELECT 1 FROM json_each(doc_revision.audiences) WHERE value = 'user');
