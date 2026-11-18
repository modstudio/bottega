// concern: outbox-read
/** Owns the shared predicate for reading locally pending hosted-record writes. */

// SQLite documents unary + to prevent terms driving index choice; outbox_synced_at is selective.
export const PENDING_OUTBOX_PREDICATE_SQL =
  'synced_at IS NULL AND +quarantined_at IS NULL AND +retired_at IS NULL'
