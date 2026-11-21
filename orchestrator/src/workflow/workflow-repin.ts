// concern: workflow repin
/** Re-points one open cursor to the current production composition after a pure compatibility ruling. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isOperatorSession } from '../../../shared/caller-classification.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { taskFlowLocalStore, taskFlowReadStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { workflowCursorReference } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import type { CursorRepinnedEvent, CursorTrailEntry } from './workflow-cursor-trail.ts'
import { decideWorkflowRepin, type RepinStep } from './workflow-repin-decision.ts'
import { composeWorkflow } from './workflows.ts'

const repinSteps = (composition: ReturnType<typeof composeWorkflow>): RepinStep[] =>
  composition.steps.map((step) => ({
    slug: step.slug,
    floors: step.floor.map((floor) => floor.kind),
  }))

export async function repinWorkflowCursor(input: {
  row: SelectableCursorRow
  reason: string
  context: WorkflowCursorContext
  database?: Database
}) {
  const reason = input.reason.trim()
  if (!reason) throw new Error('repin reason is required; pass --reason "<why>"')
  const d = input.database ?? db()
  const oldComposition = cursorComposition(input.row, d)
  const nextComposition = composeWorkflow(
    input.row.workflow_slug,
    input.row.project,
    input.row.mode_slug,
    JSON.parse(input.row.args) as Record<string, string>,
    d,
    {},
    cursorAutonomy(input.row),
  )
  const trail = JSON.parse(input.row.closed) as CursorTrailEntry[]
  const openQuestion = (
    await taskFlowReadStore(d, input.context.taskFlowClient).waitingWorkflowQuestions()
  ).some((question) => question.workflow_cursor_record_id === input.row.record_id)
  const decision = decideWorkflowRepin({
    cursor: input.row.id,
    oldSteps: repinSteps(oldComposition),
    newSteps: repinSteps(nextComposition),
    currentOrdinal: input.row.ordinal,
    trail,
    holderSession: input.row.session_id,
    callerSession: input.context.session ?? null,
    callerIsOperator: isOperatorSession(input.context.session ?? null),
    pendingQuestion: openQuestion,
    pendingAwait: input.row.state === 'awaiting-ruling',
    alreadyCurrent:
      input.row.workflow_version_record_id === nextComposition.workflow.record_id &&
      input.row.catalogue_version_record_id === nextComposition.catalogue.record_id,
    retryCommand: `${PLATFORM_SLUG} workflow repin${workflowCursorReference(input.row.id, input.row.project).cli} --reason <text>`,
  })
  if (decision.action === 'refuse') throw new Error(decision.message)
  const callerSession = input.context.session!
  const at = nowIso()
  const event: CursorRepinnedEvent = {
    event: 'repinned',
    workflow: {
      from: input.row.workflow_version,
      to: nextComposition.workflow.version,
    },
    catalogue: {
      from: input.row.catalogue_version,
      to: nextComposition.catalogue.version,
    },
    reason,
    callerSession,
    at,
  }
  const payload: TaskFlowIntentInput<'repin'> = {
    requestId: taskFlowRequestId('repin', [input.row.record_id, String(input.row.revision)]),
    stage: {
      id: input.row.record_id,
      expectedRevision: input.row.revision,
      values: {
        workflowVersionId: nextComposition.workflow.record_id,
        catalogueVersionId: nextComposition.catalogue.record_id,
        totalSteps: nextComposition.steps.length,
        closedStepNotes: [...trail, event],
        updatedAt: at,
      },
    },
  }
  const hosted = await writeHostedTaskFlow(
    'repin',
    payload,
    taskFlowWriteTarget(input.row.project, d),
    input.context.taskFlowClient,
  )
  writeTransaction(() => taskFlowLocalStore(d).write('repin', payload, hosted), d)
  return {
    cursor: input.row.id,
    workflowVersion: {
      from: input.row.workflow_version,
      to: nextComposition.workflow.version,
    },
    catalogueVersion: {
      from: input.row.catalogue_version,
      to: nextComposition.catalogue.version,
    },
    currentStep: { n: input.row.ordinal + 1, slug: input.row.step_slug },
    summary: `Cursor ${input.row.id} repinned workflow ${input.row.workflow_version} -> ${nextComposition.workflow.version}, catalogue ${input.row.catalogue_version} -> ${nextComposition.catalogue.version}, at step ${input.row.ordinal + 1} ${input.row.step_slug}.`,
  }
}
