// concern: task flow migration
/** Reports open keyed cursors the task-flow backfill leaves unmerged, whether deliberately or because no flow was created. */

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
  const missing = d
    .query<{ number: number }, []>(
      `SELECT cursor.number FROM workflow_cursor cursor
       WHERE cursor.workflow_key<>'' AND cursor.task_record_id IS NOT NULL
         AND cursor.state NOT IN ('done','abandoned')
         AND NOT EXISTS (
           SELECT 1 FROM task_flow flow WHERE flow.task_record_id=cursor.task_record_id
         )
       ORDER BY cursor.number`,
    )
    .all()
  return [
    ...extras.map(
      ({ number, kept }) => `cursor ${number} not merged; cursor ${kept} is the task's stage`,
    ),
    ...unresolved.map(({ number }) => `cursor ${number} not merged; task key did not resolve`),
    ...missing.map(({ number }) => `cursor ${number} not merged; task flow was not created`),
  ]
}

export function reportTaskFlowBackfill(d: Database): void {
  for (const report of taskFlowBackfillReports(d)) console.error(`task flow migration: ${report}`)
}
