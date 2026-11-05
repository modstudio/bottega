ALTER TABLE record_change NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
ALTER TABLE config_entry NO FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_related_subject NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(
    format('%s %s/%s in spaces [%s]', grouped.owner_user_id, grouped.scope, grouped.slug, grouped.spaces),
    '; ' ORDER BY grouped.owner_user_id, grouped.scope, grouped.slug
  ) INTO duplicates
  FROM (
    SELECT d.owner_user_id, d.scope, d.slug,
      string_agg(DISTINCT d.space_id::text, ', ' ORDER BY d.space_id::text) AS spaces
    FROM doc d
    JOIN "user" u ON u.id=d.owner_user_id
    WHERE d.owner_user_id IS NOT NULL
      AND d.subject IS NULL
      AND d.scope IN ('settings','canon')
      AND d.deleted_at IS NULL
    GROUP BY d.owner_user_id, d.scope, d.slug
    HAVING count(DISTINCT d.space_id) > 1
  ) grouped;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'personal documents exist in more than one space: %', duplicates;
  END IF;

  SELECT string_agg(
    format('%s %s/%s in spaces [%s]', grouped.user_id, grouped.environment, grouped.key, grouped.spaces),
    '; ' ORDER BY grouped.user_id, grouped.environment, grouped.key
  ) INTO duplicates
  FROM (
    SELECT c.user_id, c.environment, c.key,
      string_agg(DISTINCT c.space_id::text, ', ' ORDER BY c.space_id::text) AS spaces
    FROM config_entry c
    WHERE c.user_id IS NOT NULL
    GROUP BY c.user_id, c.environment, c.key
    HAVING count(DISTINCT c.space_id) > 1
  ) grouped;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'personal config entries exist in more than one space: %', duplicates;
  END IF;

  SELECT string_agg(u.id::text, ', ' ORDER BY u.id::text) INTO duplicates
  FROM "user" u
  WHERE u.personal_space_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM doc d
        WHERE d.owner_user_id=u.id AND d.subject IS NULL AND d.scope IN ('settings','canon')
      )
      OR EXISTS (SELECT 1 FROM config_entry c WHERE c.user_id=u.id)
    );
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'users with personal items have no personal space: %', duplicates;
  END IF;

  -- Related subjects name subjects of the source space, so a personal document carrying them
  -- cannot move without losing them; refuse rather than orphan the rows.
  SELECT string_agg(DISTINCT d.id::text, ', ') INTO duplicates
  FROM doc d
  JOIN doc_related_subject r ON r.doc_id=d.id AND r.space_id=d.space_id
  JOIN "user" u ON u.id=d.owner_user_id
  WHERE d.subject IS NULL AND d.scope IN ('settings','canon')
    AND u.personal_space_id IS NOT NULL AND d.space_id<>u.personal_space_id;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'personal documents carry related subjects of their source space: %', duplicates;
  END IF;
END
$$;

UPDATE record_change change
SET space_id=u.personal_space_id
FROM doc d
JOIN "user" u ON u.id=d.owner_user_id
WHERE d.subject IS NULL
  AND d.scope IN ('settings','canon')
  AND d.space_id<>u.personal_space_id
  AND change.table_name='doc'
  AND change.row_id=d.id;

UPDATE record_change change
SET space_id=u.personal_space_id
FROM doc_revision revision
JOIN "user" u ON u.id=revision.owner_user_id
WHERE revision.subject IS NULL
  AND revision.scope IN ('settings','canon')
  AND revision.space_id<>u.personal_space_id
  AND change.table_name='doc_revision'
  AND change.row_id=revision.id;

UPDATE doc_revision revision
SET space_id=u.personal_space_id
FROM "user" u
WHERE revision.owner_user_id=u.id
  AND revision.subject IS NULL
  AND revision.scope IN ('settings','canon')
  AND revision.space_id<>u.personal_space_id;

UPDATE doc document
SET space_id=u.personal_space_id
FROM "user" u
WHERE document.owner_user_id=u.id
  AND document.subject IS NULL
  AND document.scope IN ('settings','canon')
  AND document.space_id<>u.personal_space_id;

UPDATE config_entry entry
SET space_id=u.personal_space_id
FROM "user" u
WHERE entry.user_id=u.id
  AND entry.space_id<>u.personal_space_id;

ALTER TABLE record_change FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE doc FORCE ROW LEVEL SECURITY;
ALTER TABLE config_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE doc_related_subject FORCE ROW LEVEL SECURITY;
