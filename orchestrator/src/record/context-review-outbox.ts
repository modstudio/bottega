// concern: context-review-outbox
/** Builds and backfills hosted-record mutations for local context-review events. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso } from '../database/db.ts'
import { machineId } from './machine-identity.ts'
import { insertOutboxRow } from './outbox-enqueue.ts'
import { stringifyOutboxPayload } from './outbox-sanitize.ts'

export type ContextReviewPayloadRow = {
  id: string
  sessionId: string
  at: string
  intervalMs: number
  items: number
  flagged: number
  itemIds: string
}

export function buildContextReviewPayload(
  row: ContextReviewPayloadRow,
  rowMachineId: string,
  updatedAt: string,
) {
  return {
    id: row.id,
    spaceId: PLATFORM_SPACE_ID,
    machineId: rowMachineId,
    localId: null,
    sessionId: row.sessionId,
    at: row.at,
    intervalMs: row.intervalMs,
    items: row.items,
    flagged: row.flagged,
    itemIds: row.itemIds,
    createdAt: row.at,
    updatedAt,
  }
}

export function backfillContextReviews(database: Database, updatedAt = nowIso()): number {
  const rows = database
    .query<ContextReviewPayloadRow, []>(
      `SELECT record_id id,session_id sessionId,at,interval_ms intervalMs,items,flagged,
              item_ids itemIds FROM context_review
        WHERE NOT EXISTS (SELECT 1 FROM outbox
                          WHERE kind='context_review' AND row_id=context_review.record_id)
        ORDER BY at,record_id`,
    )
    .all()
  for (const row of rows)
    insertOutboxRow(database, {
      recordId: newRecordId(),
      kind: 'context_review',
      rowId: row.id,
      payload: stringifyOutboxPayload(
        'context_review',
        buildContextReviewPayload(row, machineId(), updatedAt),
      ),
      createdAt: updatedAt,
    })
  return rows.length
}
