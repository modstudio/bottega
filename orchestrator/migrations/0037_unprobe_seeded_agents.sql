UPDATE agent
SET probed_at = NULL,
    probe_result = NULL
WHERE probed_at = '2026-09-07T00:00:00.000Z'
  AND probe_result IN (
    '{"source":"migrated verified capabilities"}',
    '{"source":"migrated verified capabilities","legacy":true}'
  );
