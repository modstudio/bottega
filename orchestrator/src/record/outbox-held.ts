// concern: outbox-held
/** Reads pending outbox rows held for a hosted API upgrade. */
import type { Database } from 'bun:sqlite'
import { outboxHeldForUpgradeLikePattern } from './outbox-held-contract.ts'
import { PENDING_OUTBOX_PREDICATE_SQL } from './outbox-read.ts'

export type HeldOutboxKind = {
  kind: string
  count: number
  oldestCreatedAt: string
  reason: string
}

export function heldOutboxKinds(database: Database): HeldOutboxKind[] {
  const rows = database
    .query<{ kind: string; created_at: string; last_error: string }, [string]>(
      `SELECT kind,created_at,last_error FROM outbox
       WHERE ${PENDING_OUTBOX_PREDICATE_SQL}
         AND last_error LIKE ? ORDER BY kind,created_at,id`,
    )
    .all(outboxHeldForUpgradeLikePattern())
  const held = new Map<string, HeldOutboxKind>()
  for (const row of rows) {
    const current = held.get(row.kind)
    if (current) current.count++
    else
      held.set(row.kind, {
        kind: row.kind,
        count: 1,
        oldestCreatedAt: row.created_at,
        reason: row.last_error,
      })
  }
  return [...held.values()]
}
