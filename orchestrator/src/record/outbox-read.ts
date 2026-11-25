// concern: outbox-read
/** Owns the shared predicate for reading locally pending hosted-record writes. */

// SQLite documents unary + to prevent terms driving index choice; outbox_synced_at is selective.
export const PENDING_OUTBOX_PREDICATE_SQL =
  'synced_at IS NULL AND +quarantined_at IS NULL AND +retired_at IS NULL'

/** Matches migration 0234's partial index predicate exactly. */
export const QUARANTINED_UNRETIRED_OUTBOX_PREDICATE_SQL =
  'quarantined_at IS NOT NULL AND retired_at IS NULL'
