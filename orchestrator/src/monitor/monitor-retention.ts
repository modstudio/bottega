// concern: monitor retention
/** Releases expired monitor history while preserving the default visible tail. */

import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { drainRetentionChunks } from '../database/retention-chunks.ts'
import { recordMonitorReleasedBefore } from './monitor-retention-state.ts'
import { MONITOR_HISTORY_DEFAULT_LIMIT, MONITOR_RAW_WINDOW_MS } from './monitor-types.ts'

const MONITOR_RETENTION_CHUNK_SIZE = 20
const MONITOR_NEWEST_CTE = `newest AS (
  SELECT record_id FROM monitor_invocation
  ORDER BY started_at DESC,record_id DESC LIMIT ?2
)`
const MONITOR_EXPIRED_PREDICATE = `datetime(invocation.started_at)<datetime(?1)
  AND invocation.record_id NOT IN (SELECT record_id FROM newest)`

export type MonitorPruneResult = { invocations: number; conditions: number; more: boolean }

function eligibleMonitorCounts(
  database: Database,
  cutoff: string,
): Omit<MonitorPruneResult, 'more'> {
  return database
    .query<{ invocations: number; conditions: number }, [string, number]>(
      `WITH ${MONITOR_NEWEST_CTE}, expired AS (
         SELECT invocation.record_id FROM monitor_invocation invocation
         WHERE ${MONITOR_EXPIRED_PREDICATE}
       )
       SELECT COUNT(*) invocations,
         (SELECT COUNT(*) FROM monitor_condition
          WHERE invocation_record_id IN (SELECT record_id FROM expired)) conditions
       FROM expired`,
    )
    .get(cutoff, MONITOR_HISTORY_DEFAULT_LIMIT)!
}

export function pruneMonitorRows(
  database: Database,
  options: { now?: number; limit?: number; timeBoundMs?: number; dryRun?: boolean } = {},
): MonitorPruneResult {
  const cutoff = new Date((options.now ?? Date.now()) - MONITOR_RAW_WINDOW_MS).toISOString()
  if (options.dryRun) {
    const counts = eligibleMonitorCounts(database, cutoff)
    return { ...counts, more: counts.invocations > 0 }
  }
  const limit = options.limit ?? MONITOR_RETENTION_CHUNK_SIZE
  type SelectedInvocation = { record_id: string; started_at: string; conditions: number }
  const drained = drainRetentionChunks<
    SelectedInvocation,
    { invocations: number; conditions: number }
  >({
    limit,
    timeBoundMs: options.timeBoundMs,
    initial: { invocations: 0, conditions: 0 },
    select: (chunkLimit) =>
      database
        .query<SelectedInvocation, [string, number, number]>(
          `WITH ${MONITOR_NEWEST_CTE}
         SELECT invocation.record_id,invocation.started_at,
           (SELECT COUNT(*) FROM monitor_condition condition
            WHERE condition.invocation_record_id=invocation.record_id) conditions
         FROM monitor_invocation invocation
         WHERE ${MONITOR_EXPIRED_PREDICATE}
         ORDER BY invocation.started_at,invocation.record_id LIMIT ?3`,
        )
        .all(cutoff, MONITOR_HISTORY_DEFAULT_LIMIT, chunkLimit),
    remove: (selected) => {
      writeTransaction(() => {
        const releasedBefore = selected.at(-1)!.started_at
        recordMonitorReleasedBefore(database, releasedBefore)
        const remove = database.query('DELETE FROM monitor_invocation WHERE record_id=?')
        for (const row of selected) remove.run(row.record_id)
      }, database)
    },
    accumulate: (total, selected) => ({
      invocations: total.invocations + selected.length,
      conditions: total.conditions + selected.reduce((sum, row) => sum + row.conditions, 0),
    }),
  })
  return { ...drained.total, more: drained.more }
}
