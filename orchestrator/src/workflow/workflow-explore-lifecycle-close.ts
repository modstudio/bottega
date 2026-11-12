// concern: workflow explore lifecycle close
/** Closes an idle explore from session lifecycle cleanup without impersonating an agent ruling. */

import type { Database } from 'bun:sqlite'
import { nowIso, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { workflowTextDeletionIds } from './workflow-text.ts'

export type ExploreLifecycleOutcome = 'answered' | 'expired'

export async function closeExploreForLifecycle(
  cursorRecordId: string,
  outcome: ExploreLifecycleOutcome,
  database: Database,
): Promise<void> {
  const row = await taskFlowReadStore(database).stageByRecordId(cursorRecordId)
  if (row?.workflow_slug !== 'explore' || row.workflow_key || row.state === 'done') return
  if (row.state === 'abandoned') return
  const openQuestion = database
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM question WHERE workflow_cursor_record_id=?
       AND ${questionOpenSql('question')} LIMIT 1`,
    )
    .get(row.record_id)
  if (openQuestion)
    throw new Error(
      `workflow question ${openQuestion.record_id} is still open; answer or abandon it`,
    )

  const at = nowIso()
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({
    n: row.total_steps,
    slug: 'close',
    note: `session lifecycle closed explore as ${outcome}`,
    outcome,
    at,
  })
  const deleteTextIds =
    outcome === 'expired'
      ? []
      : await workflowTextDeletionIds(row.record_id, Boolean(row.task_record_id), database)
  const payload: TaskFlowIntentInput<'advance'> = {
    requestId: taskFlowRequestId('advance', [
      row.record_id,
      String(row.revision),
      'session-lifecycle',
      outcome,
    ]),
    stage: {
      id: row.record_id,
      expectedRevision: row.revision,
      values: {
        arguments: JSON.parse(row.args) as Record<string, string>,
        activeOrdinal: row.total_steps - 1,
        activeSlug: 'close',
        state: 'done',
        closedStepNotes: closed,
        question: null,
        sessionId: row.session_id,
        lastAdvancedMachineId: machineId(),
        updatedAt: at,
      },
    },
    deleteTextIds,
  }
  const hosted = await writeHostedTaskFlow(
    'advance',
    payload,
    taskFlowWriteTarget(row.project, database),
  )
  writeTransaction(() => taskFlowLocalStore(database).write('advance', payload, hosted), database)
}
