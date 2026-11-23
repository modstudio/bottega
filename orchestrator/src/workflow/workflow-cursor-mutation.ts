// concern: workflow-cursor-mutation
/** Persists terminal cursor mutations and their task-flow projection. */
import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { waitingQuestions } from '../question-store/question-store-read.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { closeQuestions } from '../run/question-close.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { refuseTerminalCursor } from './workflow-cursor-result.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'
import { followTaskCursorClaim, taskClaimReleaseWarning } from './workflow-task-claim.ts'
import { workflowTextDeletionIds } from './workflow-text.ts'

export async function closeOpenWorkflowQuestion(
  cursorId: string,
  reason: 'advanced-without-ruling' | 'abandoned',
  at: string,
  d: Database,
): Promise<void> {
  const ids = (await waitingQuestions(d))
    .filter(({ workflow_cursor_record_id }) => workflow_cursor_record_id === cursorId)
    .map(({ question_record_id }) => question_record_id)
  await closeQuestions(d, ids, reason, sessionId(), at)
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
        sessionId: cursorOwnerAfter('abandon', row.session_id, context.session),
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
  if (row.state === 'awaiting-ruling')
    await closeOpenWorkflowQuestion(row.record_id, 'abandoned', at, d)
  const result = writeTransaction(() => {
    taskFlowLocalStore(d).write('abandon', payload, hosted)
    return {
      text: `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} was abandoned at step ${row.ordinal + 1} ${row.step_slug}.`,
    }
  }, d)
  try {
    await followTaskCursorClaim({
      project: row.project,
      taskKey: row.workflow_key || null,
      session: context.session,
      verb: 'abandon',
      database: d,
    })
    return result.text
  } catch (error) {
    return row.workflow_key
      ? `${result.text}\n${taskClaimReleaseWarning(row.project, row.workflow_key, error)}`
      : result.text
  }
}

/** Undo a newly inserted task cursor when its follow-on claim cannot be taken. */
export async function abandonCursorAfterClaimFailure(
  row: SelectableCursorRow,
  context: WorkflowCursorContext,
  database: Database,
  error: unknown,
): Promise<never> {
  try {
    await abandonWorkflowCursor(row, 'task claim take failed', context, database)
  } catch (abandonError) {
    const detail = error instanceof Error ? error.message : String(error)
    const abandonDetail =
      abandonError instanceof Error ? abandonError.message : String(abandonError)
    throw new Error(
      `${detail}\nwarning: could not abandon cursor after claim failure: ${abandonDetail}`,
      {
        cause: error,
      },
    )
  }
  throw error
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
