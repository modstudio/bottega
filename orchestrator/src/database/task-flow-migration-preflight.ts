// concern: task flow migration
/** Reports open keyed cursors the task-flow backfill deliberately leaves unmerged. */

import type { Database } from 'bun:sqlite'

export function taskFlowBackfillReports(d: Database): string[] {
  const unresolved = d
    .query<{ number: number }, []>(
      `SELECT number FROM workflow_cursor
       WHERE workflow_key<>'' AND task_record_id IS NULL AND state NOT IN ('done','abandoned')
       ORDER BY number`,
    )
    .all()
  const extras = d
    .query<{ number: number; kept: number }, []>(
      `SELECT number,kept FROM (
         SELECT number,FIRST_VALUE(number) OVER (
           PARTITION BY task_record_id ORDER BY number DESC
         ) kept,ROW_NUMBER() OVER (
           PARTITION BY task_record_id ORDER BY number DESC
         ) task_rank
         FROM workflow_cursor
         WHERE workflow_key<>'' AND task_record_id IS NOT NULL
           AND state NOT IN ('done','abandoned')
       ) WHERE task_rank>1 ORDER BY number`,
    )
    .all()
  return [
    ...extras.map(
      ({ number, kept }) => `cursor ${number} not merged; cursor ${kept} is the task's stage`,
    ),
    ...unresolved.map(({ number }) => `cursor ${number} not merged; task key did not resolve`),
  ]
}

export function reportTaskFlowBackfill(d: Database): void {
  for (const report of taskFlowBackfillReports(d)) console.error(`task flow migration: ${report}`)
}
