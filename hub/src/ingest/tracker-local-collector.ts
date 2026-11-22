import type { Database } from 'bun:sqlite'
import type { TrackerTask } from '../../../shared/trackers.ts'
import { writeTransaction } from '../db.ts'
import { queueHostedChange } from '../outbox.ts'
import { HOSTED_STATUS_EVENT_TABLE, HOSTED_TASK_TABLE } from '../push-contract.ts'
import { collectorTaskShouldQueue } from '../task-hosted-row.ts'
import type { TaskRow } from '../task-row.ts'
import {
  retireTrackerRowPlan,
  type TrackerTaskRowPlan,
  trackerOutOfScopeReason,
  trackerTaskFromRow,
} from './tracker-row-plan.ts'

type PlanTask = (conn: Database, task: TrackerTask, at: string) => TrackerTaskRowPlan
type ApplyPlan = (conn: Database, plan: TrackerTaskRowPlan) => void

export function retireLocalTrackerRows(
  project: string,
  prefixes: readonly string[],
  at: string,
  prefix: (key: string) => string,
  applyPlan: ApplyPlan,
): number {
  if (!prefixes.length) return 0
  return writeTransaction((conn) => {
    const rows = conn
      .query<TaskRow, [string]>(
        `SELECT * FROM task
         WHERE project=? AND source='mcp' AND retired_reason IS NULL`,
      )
      .all(project)
    let retired = 0
    for (const row of rows) {
      if (prefixes.some((declared) => declared.toLowerCase() === prefix(row.key).toLowerCase()))
        continue
      const retiredRow = retireTrackerRowPlan(
        row,
        at,
        trackerOutOfScopeReason(project, row.key, prefixes, prefix),
      )
      const plan: TrackerTaskRowPlan = {
        task: trackerTaskFromRow(retiredRow.row),
        stored: row,
        row: retiredRow.row,
        changed: retiredRow.changed,
        event: null,
        ambiguousParentKeys: [],
      }
      if (!plan.changed) continue
      applyPlan(conn, plan)
      queueHostedChange(conn, HOSTED_TASK_TABLE, row.record_id, 'upsert', at, null, undefined)
      retired++
    }
    return retired
  })
}

export function dropLocalTrackerRows(
  project: string,
  keys: Iterable<string>,
  at: string,
  prefixes: readonly string[],
  prefix: (key: string) => string,
  planTask: PlanTask,
  applyPlan: ApplyPlan,
): { dropped: number; activity: boolean; changed: number } {
  let dropped = 0
  let changed = 0
  writeTransaction((conn) => {
    const read = conn.query<TaskRow, [string, string]>(
      `SELECT * FROM task WHERE project=? AND key=? AND source='mcp'`,
    )
    for (const key of new Set(keys)) {
      if (
        prefixes.length &&
        !prefixes.some((declared) => declared.toLowerCase() === prefix(key).toLowerCase())
      )
        continue
      const row = read.get(project, key)
      if (!row || row.status_category === 'dropped') continue
      const plan = planTask(
        conn,
        {
          ...trackerTaskFromRow(row),
          status: 'deleted',
          category: 'dropped',
          updatedAt: at,
        },
        at,
      )
      plan.row.opened_at = row.opened_at
      plan.row.closed_at = row.closed_at ?? at
      applyPlan(conn, plan)
      if (collectorTaskShouldQueue('mcp', plan.row, plan.changed))
        queueHostedChange(
          conn,
          HOSTED_TASK_TABLE,
          plan.row.record_id,
          'upsert',
          at,
          null,
          undefined,
        )
      if (plan.event)
        queueHostedChange(
          conn,
          HOSTED_STATUS_EVENT_TABLE,
          plan.event.record_id,
          'upsert',
          at,
          null,
          undefined,
        )
      dropped++
      if (plan.event) changed++
    }
  })
  return { dropped, activity: dropped > 0, changed }
}
