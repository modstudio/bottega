// concern: workflow-cursor-mutation
/** Persists terminal cursor mutations and their task-flow projection. */
import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { closeQuestions } from '../run/question-close.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { refuseTerminalCursor } from './workflow-cursor-result.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { deleteWorkflowTextLocally, workflowTextDeletionIds } from './workflow-text.ts'

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
  row: WorkflowCloseCursor,
  reason: string,
  context: WorkflowCursorContext,
  d: Database,
): Promise<string> {
  refuseTerminalCursor(row)
  const at = nowIso()
  const closed = abandonedCursorTrail(row, reason, at)
  const obligations = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM workflow_obligation WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL',
    )
    .all(row.record_id)
  const deleteTextIds = workflowTextDeletionIds(row.record_id, Boolean(row.task_record_id), d)
  const flow = row.task_flow_record_id
    ? d
        .query<
          { record_id: string; revision: number; open_stage_cursor_record_id: string | null },
          [string]
        >(
          'SELECT record_id,revision,open_stage_cursor_record_id FROM task_flow WHERE record_id=?',
        )
        .get(row.task_flow_record_id)
    : null
  const closesOpenStage = flow?.open_stage_cursor_record_id === row.record_id
  const parts = abandonmentRevisionParts(row, flow)
  const hosted = await writeHostedTaskFlow(
    'abandon',
    {
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
      obligationUpdates: obligations.map(({ record_id }) => ({
        id: record_id,
        stageRecordId: row.record_id,
        abandonedAt: at,
        abandonedReason: reason.trim(),
      })),
      deleteTextIds,
    },
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  return writeTransaction(() => {
    const current = d
      .query<{ revision: number }, [string]>(
        'SELECT revision FROM workflow_cursor WHERE record_id=?',
      )
      .get(row.record_id)
    if (!current || current.revision !== row.revision)
      throw new Error(`workflow cursor ${row.id} changed while it was abandoned; rerun the command`)
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'abandoned', at, d)
    d.query(
      `UPDATE workflow_obligation SET abandoned_at=?,abandoned_reason=? WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL`,
    ).run(at, reason.trim(), row.record_id)
    deleteWorkflowTextLocally(deleteTextIds, d)
    d.query(`UPDATE workflow_cursor SET state='abandoned',closed=?,question=NULL,
      session_id=COALESCE(?,session_id),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
      last_advanced_machine_id=?,revision=? WHERE record_id=?`).run(
      JSON.stringify(closed),
      context.session ?? null,
      at,
      machineId(),
      machineId(),
      hosted?.revisions[row.record_id] ?? row.revision + 1,
      row.record_id,
    )
    if (flow && closesOpenStage)
      d.query(
        `UPDATE task_flow SET open_stage_cursor_record_id=NULL,updated_at=?,updated_machine_id=?,revision=? WHERE record_id=?`,
      ).run(at, machineId(), hosted?.revisions[flow.record_id] ?? flow.revision + 1, flow.record_id)
    return `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} was abandoned at step ${row.ordinal + 1} ${row.step_slug}.`
  }, d)
}

function abandonedCursorTrail(
  row: WorkflowCloseCursor,
  reason: string,
  at: string,
): CursorTrailEntry[] {
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({ n: row.ordinal + 1, slug: row.step_slug, note: `abandoned: ${reason.trim()}`, at })
  return closed
}

function abandonmentRevisionParts(
  row: WorkflowCloseCursor,
  flow: { record_id: string; revision: number } | null,
): string[] {
  return [
    { id: row.record_id, revision: row.revision },
    ...(flow ? [{ id: flow.record_id, revision: flow.revision }] : []),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(({ id, revision }) => [id, String(revision)])
}
