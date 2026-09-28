// concern: outbox-operator
/** Applies explicit outbox operator dispositions with their dependency proofs. */
import type { Database } from 'bun:sqlite'
import { db, nowIso, sessionId } from '../database/db.ts'
import { outboxRowBlockedByRetiredParent } from './outbox-dependency.ts'
import { retireOutboxRow } from './outbox-quarantine.ts'

export function retireOutboxRowWithDependencyProof(
  rowId: number,
  reason: string,
  database: Database = db(),
  at = nowIso(),
  actorSession = sessionId(),
): void {
  retireOutboxRow(rowId, reason, database, at, actorSession, (current, id) =>
    Boolean(outboxRowBlockedByRetiredParent(current, id)),
  )
}
