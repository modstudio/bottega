// concern: record-sync
/** Decides how same-batch parent outcomes affect local sync results. */
import type { RecordSyncRowResult } from './record-sync-contract.ts'

export type RecordSyncBatchDependency = {
  id: number
  sameBatchParentIds: readonly number[]
}

export type RecordSyncResultTreatment = {
  id: number
  treatment: 'apply' | 'pending'
}

export function recordSyncResultTreatments(
  rows: readonly RecordSyncBatchDependency[],
  results: readonly RecordSyncRowResult[],
): RecordSyncResultTreatment[] {
  const parentSynced = new Map<number, boolean>()
  return rows.map((row, index) => {
    const result = results[index]!
    const waiting = row.sameBatchParentIds.some((parentId) => !parentSynced.get(parentId))
    if (waiting && result.status === 'synced') {
      throw new Error(
        `record sync contract violation: row ${row.id} was reported synced after a same-batch parent did not sync`,
      )
    }
    const treatment = waiting ? 'pending' : 'apply'
    parentSynced.set(row.id, treatment === 'apply' && result.status === 'synced')
    return { id: row.id, treatment }
  })
}
