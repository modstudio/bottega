// concern: record-sync-results
/** Validates and applies authoritative hosted-record row results to the local outbox. */
import type { Database } from 'bun:sqlite'
import { markOutboxRowSynced } from './outbox-dependency.ts'
import { quarantineOutboxRow } from './outbox-quarantine.ts'
import type { RecordSyncRequestRow, RecordSyncResponse } from './record-sync-contract.ts'
import {
  type RecordSyncBatchDependency,
  recordSyncResultTreatments,
} from './record-sync-result-decision.ts'
import type { HeldRecordSyncRows, OutboxRow } from './record-sync-types.ts'

function countHeld(held: Map<string, HeldRecordSyncRows>, kind: string, reason: string): void {
  const current = held.get(kind)
  if (current) current.rows++
  else held.set(kind, { kind, rows: 1, reason })
}

function validateBatchResults(batch: RecordSyncRequestRow[], response: RecordSyncResponse): void {
  if (response.results.length !== batch.length)
    throw new Error('record sync response did not contain one result per requested row')
  for (let index = 0; index < batch.length; index++) {
    const row = batch[index]!
    const result = response.results[index]!
    if (result === null || typeof result !== 'object')
      throw new Error('record sync response contained an invalid row result')
    if (result.id !== row.id)
      throw new Error('record sync response order did not match the request')
    if (!['synced', 'quarantined', 'deferred', 'held'].includes(result.status))
      throw new Error('record sync response contained an invalid row status')
    if (
      (result.status === 'quarantined' ||
        result.status === 'deferred' ||
        result.status === 'held') &&
      (typeof result.reason !== 'string' || !result.reason.trim())
    ) {
      throw new Error('record sync response contained an invalid row reason')
    }
    if (
      result.status === 'deferred' &&
      (typeof result.spaceId !== 'string' || !result.spaceId.trim())
    ) {
      throw new Error('record sync response contained an invalid deferred space')
    }
  }
}

export function applyRecordSyncBatchResults(input: {
  local: Database
  batch: RecordSyncRequestRow[]
  localRows: Map<number, OutboxRow>
  dependencies: RecordSyncBatchDependency[]
  response: RecordSyncResponse
  attempted: Set<number>
  readOnlyDeferred: Map<string, number>
  held: Map<string, HeldRecordSyncRows>
  now: () => string
}): { pushed: number; failed: number } {
  validateBatchResults(input.batch, input.response)
  const treatments = recordSyncResultTreatments(input.dependencies, input.response.results)
  let pushed = 0
  let failed = 0
  for (let index = 0; index < input.batch.length; index++) {
    const row = input.batch[index]!
    const result = input.response.results[index]!
    const treatment = treatments[index]!
    input.attempted.add(row.id)
    if (treatment.treatment === 'pending') continue
    if (result.status === 'synced') {
      markOutboxRowSynced(input.local, input.localRows.get(row.id)!, input.now())
      pushed++
    } else if (result.status === 'quarantined') {
      quarantineOutboxRow(
        input.local,
        row.id,
        input.localRows.get(row.id)!.payload,
        result.reason,
        input.now(),
      )
      failed++
    } else {
      const source = input.localRows.get(row.id)!
      input.local
        .query(
          `UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=? AND payload=?
           AND synced_at IS NULL AND quarantined_at IS NULL AND retired_at IS NULL`,
        )
        .run(result.reason, row.id, source.payload)
      if (result.status === 'deferred') {
        input.readOnlyDeferred.set(
          result.spaceId,
          (input.readOnlyDeferred.get(result.spaceId) ?? 0) + 1,
        )
      } else {
        countHeld(input.held, row.kind, result.reason)
      }
    }
  }
  return { pushed, failed }
}
