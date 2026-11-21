// concern: context-review-store
/** Records one timed context-review event and its hosted outbox mutation atomically. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { buildContextReviewPayload } from '../record/context-review-outbox.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'

export type ContextReviewEvent = {
  id: string
  sessionId: string
  at: string
  intervalMs: number
  items: number
  flagged: number
  itemIds: string[]
  itemHolders?: string[]
}

export type ReviewItemRef = string | { id: string; holder: string }

export function encodeReviewItemRefs(itemIds: string[], itemHolders?: string[]): string {
  return JSON.stringify(
    itemHolders ? itemIds.map((id, index) => ({ id, holder: itemHolders[index]! })) : itemIds,
  )
}

export function decodeReviewItemRefs(value: string): ReviewItemRef[] {
  return JSON.parse(value) as ReviewItemRef[]
}

/** Reads the recorded review measurements in one report window. */
export function contextReviewWindow(since: string, database: Database = db()) {
  return database
    .query<{ session_id: string; at: string; items: number; flagged: number }, [string]>(
      'SELECT session_id,at,items,flagged FROM context_review WHERE at>=? ORDER BY session_id,at',
    )
    .all(since)
    .map((row) => ({
      sessionId: row.session_id,
      at: row.at,
      items: row.items,
      flagged: row.flagged,
    }))
}

export function recordContextReview(
  input: Omit<ContextReviewEvent, 'id' | 'at'>,
  dependencies: { database?: Database; now?: () => string; machine?: () => string } = {},
): ContextReviewEvent {
  const database = dependencies.database ?? db(true)
  const row = { ...input, id: newRecordId(), at: (dependencies.now ?? nowIso)() }
  const itemIds = encodeReviewItemRefs(row.itemIds, row.itemHolders)
  writeTransaction(() => {
    database
      .query(`INSERT INTO context_review
        (record_id,session_id,at,interval_ms,items,flagged,item_ids) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.sessionId, row.at, row.intervalMs, row.items, row.flagged, itemIds)
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'context_review',
      rowId: row.id,
      payload: stringifyOutboxPayload(
        'context_review',
        buildContextReviewPayload(
          { ...row, itemIds },
          (dependencies.machine ?? machineId)(),
          row.at,
        ),
      ),
      createdAt: row.at,
    })
  }, database)
  return row
}
