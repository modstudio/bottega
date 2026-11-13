// concern: workflow-cursor-mutation
/** Persists terminal cursor mutations and their task-flow projection. */
import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { closeQuestions } from '../run/question-close.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import { refreshStaleMirror } from './task-flow-mirror-refresh.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { refuseTerminalCursor } from './workflow-cursor-result.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { workflowTextDeletionIds } from './workflow-text.ts'

export function closeOpenWorkflowQuestion(
  cursorId: string,
  reason: 'advanced-without-ruling' | 'abandoned',
  at: string,
  d: Database,
): void {
  const ids = d
    .query<{ record_id: string }, [string]>(
      `SELECT record_id FROM question
       WHERE workflow_cursor_record_id=? AND ${questionOpenSql('question')}`,
    )
    .all(cursorId)
    .map((question) => question.record_id)
  closeQuestions(d, ids, reason, sessionId(), at)
}

export async function abandonWorkflowCursor(
  row: SelectableCursorRow,
  reason: string,
  context: WorkflowCursorContext,
  d: Database,
): Promise<string> {
  refuseTerminalCursor(row)
  const at = nowIso()
  const closed = abandonedCursorTrail(row, reason, at)
  const store = taskFlowReadStore(d, context.taskFlowClient)
  const obligations = await store.openObligationRecordIds(row.record_id)
  const deleteTextIds = await workflowTextDeletionIds(
    row.record_id,
    Boolean(row.task_record_id),
    d,
    context.taskFlowClient,
  )
  const flow = row.task_flow_record_id ? await store.flowState(row.task_flow_record_id) : null
  const closesOpenStage = flow?.open_stage_cursor_record_id === row.record_id
  const parts = abandonmentRevisionParts(row, flow)
  const payload: TaskFlowIntentInput<'abandon'> = {
    requestId: taskFlowRequestId('abandon', parts),
    stage: {
      id: row.record_id,
      expectedRevision: row.revision,
      values: {
        state: 'abandoned',
        closedStepNotes: closed,
        question: null,
        sessionId: context.session ?? row.session_id,
        updatedAt: at,
      },
    },
    ...(flow && closesOpenStage
      ? {
          flow: {
            id: flow.record_id,
            expectedRevision: flow.revision,
            values: {
              openStageRecordId: null,
              updatedMachineId: machineId(),
              updatedAt: at,
            },
          },
        }
      : {}),
    obligationUpdates: obligations.map((recordId) => ({
      id: recordId,
      stageRecordId: row.record_id,
      abandonedAt: at,
      abandonedReason: reason.trim(),
    })),
    deleteTextIds,
  }
  const hosted = await writeHostedTaskFlow(
    'abandon',
    payload,
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  const result = writeTransaction(() => {
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'abandoned', at, d)
    const mirror = taskFlowLocalStore(d).write('abandon', payload, hosted).mirror[row.record_id]
    return {
      text: `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} was abandoned at step ${row.ordinal + 1} ${row.step_slug}.`,
      mirror,
    }
  }, d)
  if (result.mirror === 'refresh')
    await refreshStaleMirror(
      d,
      {
        recordId: row.record_id,
        project: row.project,
        taskKey: row.workflow_key,
        taskRecordId: row.task_record_id,
      },
      context.taskFlowClient,
    )
  return result.text
}

function abandonedCursorTrail(
  row: SelectableCursorRow,
  reason: string,
  at: string,
): CursorTrailEntry[] {
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({ n: row.ordinal + 1, slug: row.step_slug, note: `abandoned: ${reason.trim()}`, at })
  return closed
}

function abandonmentRevisionParts(
  row: SelectableCursorRow,
  flow: { record_id: string; revision: number } | null,
): string[] {
  return [
    { id: row.record_id, revision: row.revision },
    ...(flow ? [{ id: flow.record_id, revision: flow.revision }] : []),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(({ id, revision }) => [id, String(revision)])
}
