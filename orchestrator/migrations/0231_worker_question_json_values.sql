-- BACKFILL
UPDATE question
SET typed_options=json_extract(typed_options,'$')
WHERE CASE WHEN json_valid(typed_options)
  THEN json_type(typed_options,'$')='text'
    AND json_valid(json_extract(typed_options,'$'))
  ELSE 0 END;

UPDATE question
SET criteria=json_extract(criteria,'$')
WHERE CASE WHEN json_valid(criteria)
  THEN json_type(criteria,'$')='text'
    AND json_valid(json_extract(criteria,'$'))
  ELSE 0 END;

UPDATE question
SET levels=json_extract(levels,'$')
WHERE CASE WHEN json_valid(levels)
  THEN json_type(levels,'$')='text'
    AND json_valid(json_extract(levels,'$'))
  ELSE 0 END;

UPDATE question
SET options=json_extract(options,'$')
WHERE CASE WHEN json_valid(options)
  THEN json_type(options,'$')='text'
    AND json_valid(json_extract(options,'$'))
  ELSE 0 END;

UPDATE question
SET jev_probabilities=json_extract(jev_probabilities,'$')
WHERE CASE WHEN json_valid(jev_probabilities)
  THEN json_type(jev_probabilities,'$')='text'
    AND json_valid(json_extract(jev_probabilities,'$'))
  ELSE 0 END;

UPDATE outbox
SET payload=json_set(payload,'$.typedOptions',json(json_extract(payload,'$.typedOptions')))
WHERE kind='question' AND synced_at IS NULL
  AND CASE WHEN json_valid(payload)
    THEN json_type(payload,'$.typedOptions')='text'
      AND json_valid(json_extract(payload,'$.typedOptions'))
    ELSE 0 END;

UPDATE outbox
SET payload=json_set(payload,'$.criteria',json(json_extract(payload,'$.criteria')))
WHERE kind='question' AND synced_at IS NULL
  AND CASE WHEN json_valid(payload)
    THEN json_type(payload,'$.criteria')='text'
      AND json_valid(json_extract(payload,'$.criteria'))
    ELSE 0 END;

UPDATE outbox
SET payload=json_set(payload,'$.levels',json(json_extract(payload,'$.levels')))
WHERE kind='question' AND synced_at IS NULL
  AND CASE WHEN json_valid(payload)
    THEN json_type(payload,'$.levels')='text'
      AND json_valid(json_extract(payload,'$.levels'))
    ELSE 0 END;

UPDATE outbox
SET payload=json_set(payload,'$.options',json(json_extract(payload,'$.options')))
WHERE kind='question' AND synced_at IS NULL
  AND CASE WHEN json_valid(payload)
    THEN json_type(payload,'$.options')='text'
      AND json_valid(json_extract(payload,'$.options'))
    ELSE 0 END;

UPDATE outbox
SET payload=json_set(payload,'$.jevProbabilities',json(json_extract(payload,'$.jevProbabilities')))
WHERE kind='question' AND synced_at IS NULL
  AND CASE WHEN json_valid(payload)
    THEN json_type(payload,'$.jevProbabilities')='text'
      AND json_valid(json_extract(payload,'$.jevProbabilities'))
    ELSE 0 END;
-- /BACKFILL
