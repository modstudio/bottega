ALTER TABLE contention ADD COLUMN occurrences INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE contention AS kept
SET occurrences = (
      SELECT SUM(duplicate.occurrences) FROM contention AS duplicate
      WHERE COALESCE(duplicate.session_id, '')=COALESCE(kept.session_id, '')
        AND duplicate.resource_key=kept.resource_key AND duplicate.at=kept.at
        AND duplicate.resource_kind='store' AND duplicate.event_kind='wait'
        AND duplicate.cause='slow-statement'
    ),
    duration_ms = (
      SELECT SUM(COALESCE(duplicate.duration_ms, 0)) FROM contention AS duplicate
      WHERE COALESCE(duplicate.session_id, '')=COALESCE(kept.session_id, '')
        AND duplicate.resource_key=kept.resource_key AND duplicate.at=kept.at
        AND duplicate.resource_kind='store' AND duplicate.event_kind='wait'
        AND duplicate.cause='slow-statement'
    )
WHERE kept.resource_kind='store' AND kept.event_kind='wait' AND kept.cause='slow-statement'
  AND kept.record_id=(
    SELECT MIN(duplicate.record_id) FROM contention AS duplicate
    WHERE COALESCE(duplicate.session_id, '')=COALESCE(kept.session_id, '')
      AND duplicate.resource_key=kept.resource_key AND duplicate.at=kept.at
      AND duplicate.resource_kind='store' AND duplicate.event_kind='wait'
      AND duplicate.cause='slow-statement'
  );
--> statement-breakpoint
DELETE FROM contention AS duplicate
WHERE duplicate.resource_kind='store' AND duplicate.event_kind='wait'
  AND duplicate.cause='slow-statement'
  AND duplicate.record_id<>(
    SELECT MIN(kept.record_id) FROM contention AS kept
    WHERE COALESCE(kept.session_id, '')=COALESCE(duplicate.session_id, '')
      AND kept.resource_key=duplicate.resource_key AND kept.at=duplicate.at
      AND kept.resource_kind='store' AND kept.event_kind='wait'
      AND kept.cause='slow-statement'
  );
--> statement-breakpoint
CREATE UNIQUE INDEX contention_slow_statement_bucket
ON contention(COALESCE(session_id, ''), resource_key, at)
WHERE resource_kind='store' AND event_kind='wait' AND cause='slow-statement';
