-- BACKFILL
UPDATE question
SET typed_options=json_extract(typed_options,'$')
WHERE json_type(typed_options,'$')='text';

UPDATE question
SET criteria=json_extract(criteria,'$')
WHERE json_type(criteria,'$')='text';

UPDATE question
SET levels=json_extract(levels,'$')
WHERE json_type(levels,'$')='text';

UPDATE question
SET options=json_extract(options,'$')
WHERE json_type(options,'$')='text';

UPDATE question
SET jev_probabilities=json_extract(jev_probabilities,'$')
WHERE json_type(jev_probabilities,'$')='text';

UPDATE outbox
SET payload=json_set(payload,'$.typedOptions',json(json_extract(payload,'$.typedOptions')))
WHERE kind='question' AND synced_at IS NULL
  AND json_type(payload,'$.typedOptions')='text';

UPDATE outbox
SET payload=json_set(payload,'$.criteria',json(json_extract(payload,'$.criteria')))
WHERE kind='question' AND synced_at IS NULL
  AND json_type(payload,'$.criteria')='text';

UPDATE outbox
SET payload=json_set(payload,'$.levels',json(json_extract(payload,'$.levels')))
WHERE kind='question' AND synced_at IS NULL
  AND json_type(payload,'$.levels')='text';

UPDATE outbox
SET payload=json_set(payload,'$.options',json(json_extract(payload,'$.options')))
WHERE kind='question' AND synced_at IS NULL
  AND json_type(payload,'$.options')='text';

UPDATE outbox
SET payload=json_set(payload,'$.jevProbabilities',json(json_extract(payload,'$.jevProbabilities')))
WHERE kind='question' AND synced_at IS NULL
  AND json_type(payload,'$.jevProbabilities')='text';
-- /BACKFILL
