// concern: workflows
/** Owns cursor-local text attachments and the pure decisions governing their lifetime. */
import type { Database } from 'bun:sqlite'
import { writableDb, writeTransaction } from '../database/db.ts'
import { assertOrchestratorProse } from '../prose-service.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { taskFlowStore } from './task-flow-store.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { selectWorkflowCursor } from './workflow-cursor-selection.ts'
import type { CursorState } from './workflow-cursor-transition.ts'
import { linkWorkflowTaskLabel } from './workflow-task-linking.ts'

export const WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES = 32 * 1024
export const WORKFLOW_TEXT_CURSOR_MAX_BYTES = 64 * 1024
const WORKFLOW_TEXT_ATTACHMENT_PREFIX = 'attached-text:'

export const workflowTextAttachmentToken = (id: string): string =>
  `${WORKFLOW_TEXT_ATTACHMENT_PREFIX}${id}`

export const workflowTextAttachmentId = (reference: string): string =>
  reference.startsWith(WORKFLOW_TEXT_ATTACHMENT_PREFIX)
    ? reference.slice(WORKFLOW_TEXT_ATTACHMENT_PREFIX.length)
    : reference

export type WorkflowTextRow = {
  id: string
  cursorId: string
  stepOrdinal: number
  stepSlug: string
  body: string
}

type AttachDecision = { action: 'allow' } | { action: 'refuse'; message: string }

export function decideWorkflowTextAttach(input: {
  state: CursorState
  ownerSession: string | null
  callerSession: string | null | undefined
  attachmentBytes: number
  cursorBytes: number
}): AttachDecision {
  if (input.state === 'done' || input.state === 'abandoned')
    return {
      action: 'refuse',
      message: `workflow cursor is ${input.state}; attach to a live cursor`,
    }
  if (!input.callerSession || input.ownerSession !== input.callerSession)
    return {
      action: 'refuse',
      message: 'workflow cursor belongs to another session; attach from the session that owns it',
    }
  if (input.attachmentBytes > WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES)
    return {
      action: 'refuse',
      message:
        `WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES is ${WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES} bytes; ` +
        `the attachment is ${input.attachmentBytes} bytes; shorten the text and attach it again`,
    }
  const total = input.cursorBytes + input.attachmentBytes
  if (total > WORKFLOW_TEXT_CURSOR_MAX_BYTES)
    return {
      action: 'refuse',
      message:
        `WORKFLOW_TEXT_CURSOR_MAX_BYTES is ${WORKFLOW_TEXT_CURSOR_MAX_BYTES} bytes; ` +
        `the cursor would hold ${total} bytes; shorten the text or finish or abandon this cursor`,
    }
  return { action: 'allow' }
}

export function attachedTextReferenceMeetsFloor(input: {
  cursorId: string
  stepOrdinal: number
  stepSlug: string
  attachment: WorkflowTextRow | null
}): boolean {
  const row = input.attachment
  return Boolean(
    row &&
      row.cursorId === input.cursorId &&
      row.stepOrdinal === input.stepOrdinal &&
      row.stepSlug === input.stepSlug,
  )
}

export function workflowTextFacts(
  needs: readonly string[],
  rows: readonly WorkflowTextRow[],
): { workflowText: { stepSlug: string; body: string }[] } | Record<string, never> {
  if (!needs.includes('workflow-text')) return {}
  return {
    workflowText: [...rows]
      .sort(
        (left, right) => left.stepOrdinal - right.stepOrdinal || left.id.localeCompare(right.id),
      )
      .map(({ stepSlug, body }) => ({ stepSlug, body })),
  }
}

export function withWorkflowTextFacts<
  Step extends { needs: readonly string[]; facts: Record<string, unknown> },
>(step: Step, cursorId: string, d: Database): Step {
  return {
    ...step,
    facts: { ...step.facts, ...workflowTextFacts(step.needs, workflowTextRows(cursorId, d)) },
  }
}

function workflowTextRows(cursorId: string, d: Database): WorkflowTextRow[] {
  return taskFlowStore(d)
    .textsForStage<{
      id: string
      cursor_record_id: string
      step_ordinal: number
      step_slug: string
      body: string
    }>(cursorId)
    .map((row) => ({
      id: row.id,
      cursorId: row.cursor_record_id,
      stepOrdinal: row.step_ordinal,
      stepSlug: row.step_slug,
      body: row.body,
    }))
}

type AttachCursorRow = {
  id: number
  record_id: string
  project: string
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
  revision: number
  updated_at: string
}

function attachSelectedWorkflowText(
  row: AttachCursorRow,
  body: string,
  context: WorkflowCursorContext,
  recordId: string,
  _createdAt: string,
  d: Database,
): string {
  const existing = taskFlowStore(d).textByRecordId<{
    cursor_record_id: string
    step_ordinal: number
    step_slug: string
    body: string
  }>(recordId)
  if (existing) {
    if (
      existing.cursor_record_id !== row.record_id ||
      existing.step_ordinal !== row.ordinal + 1 ||
      existing.step_slug !== row.step_slug ||
      existing.body !== body
    )
      throw new Error(`workflow text ${recordId} already exists with different values`)
    return workflowTextAttachmentToken(recordId)
  }
  const attachmentBytes = Buffer.byteLength(body, 'utf8')
  const cursorBytes = workflowTextRows(row.record_id, d).reduce(
    (total, attachment) => total + Buffer.byteLength(attachment.body, 'utf8'),
    0,
  )
  const decision = decideWorkflowTextAttach({
    state: row.state,
    ownerSession: row.session_id,
    callerSession: context.session,
    attachmentBytes,
    cursorBytes,
  })
  if (decision.action === 'refuse') throw new Error(decision.message)
  return workflowTextAttachmentToken(recordId)
}

function attachTextIntent(row: AttachCursorRow, body: string) {
  const recordId = taskFlowRequestId('attach-text', [
    row.record_id,
    String(row.ordinal + 1),
    row.step_slug,
    body,
  ])
  return {
    recordId,
    createdAt: row.updated_at,
    input: {
      requestId: taskFlowRequestId('attach-text', [recordId]),
      rows: [
        {
          id: recordId,
          stageRecordId: row.record_id,
          stepOrdinal: row.ordinal + 1,
          stepSlug: row.step_slug,
          body,
          createdAt: row.updated_at,
        },
      ],
    },
  }
}

async function attachWorkflowTextByHandleUnchecked(
  cursor: number,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): Promise<string> {
  const row = selectWorkflowCursor({}, cursor, undefined, d) as AttachCursorRow
  const { recordId, createdAt, input } = attachTextIntent(row, body)
  const hosted = await writeHostedTaskFlow(
    'attach-text',
    input,
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  return writeTransaction(() => {
    const current = selectWorkflowCursor({}, cursor, undefined, d) as AttachCursorRow
    if (current.record_id !== row.record_id || current.revision !== row.revision)
      throw new Error(`cursor ${cursor} changed while text was attached; rerun the attach command`)
    taskFlowStore(d).write('attach-text', input, hosted)
    return attachSelectedWorkflowText(current, body, context, recordId, createdAt, d)
  }, d)
}

async function attachWorkflowTextUnchecked(
  identity: { project: string; workflow: string; mode: string; key?: string },
  cursor: number | undefined,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): Promise<string> {
  if (identity.key && context.taskRecordId)
    await linkWorkflowTaskLabel(
      d,
      {
        project: identity.project,
        workflowKey: identity.key,
        taskRecordId: context.taskRecordId,
      },
      context.taskFlowClient,
    )
  const row = selectWorkflowCursor(identity, cursor, context.session, d) as AttachCursorRow | null
  if (!row) throw new Error('workflow has no live cursor; fetch its current step first')
  const { recordId, createdAt, input } = attachTextIntent(row, body)
  const hosted = await writeHostedTaskFlow(
    'attach-text',
    input,
    taskFlowWriteTarget(row.project, d),
    context.taskFlowClient,
  )
  return writeTransaction(() => {
    const current = selectWorkflowCursor(
      identity,
      cursor,
      context.session,
      d,
    ) as AttachCursorRow | null
    if (!current || current.record_id !== row.record_id || current.revision !== row.revision)
      throw new Error(`workflow cursor changed while text was attached; rerun the attach command`)
    taskFlowStore(d).write('attach-text', input, hosted)
    return attachSelectedWorkflowText(current, body, context, recordId, createdAt, d)
  }, d)
}

export async function attachWorkflowTextByHandle(
  cursor: number,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): Promise<string> {
  await assertOrchestratorProse([{ field: 'text', text: body, prior: null }])
  return attachWorkflowTextByHandleUnchecked(cursor, body, context, d)
}

export async function attachWorkflowText(
  identity: { project: string; workflow: string; mode: string; key?: string },
  cursor: number | undefined,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): Promise<string> {
  await assertOrchestratorProse([{ field: 'text', text: body, prior: null }])
  return attachWorkflowTextUnchecked(identity, cursor, body, context, d)
}

export function workflowTextIdsToDelete(input: {
  linked: boolean
  rowIds: readonly string[]
  copiedIds: ReadonlySet<string>
}): string[] {
  return input.linked ? input.rowIds.filter((id) => input.copiedIds.has(id)) : [...input.rowIds]
}

export function workflowTextDeletionIds(cursorId: string, linked: boolean, d: Database): string[] {
  const store = taskFlowStore(d)
  const rowIds = store.textRecordIdsForStage(cursorId)
  const copiedIds = new Set(store.copiedTextRecordIdsForStage(cursorId))
  const deletable = workflowTextIdsToDelete({ linked, rowIds, copiedIds })
  return deletable
}

export function deleteWorkflowTextLocally(ids: readonly string[], d: Database): void {
  taskFlowStore(d).deleteTexts(ids)
}

export async function deleteWorkflowText(
  cursorId: string,
  linked: boolean,
  d: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
): Promise<void> {
  const ids = workflowTextDeletionIds(cursorId, linked, d)
  if (!ids.length) return
  const project = taskFlowStore(d).stageProject(cursorId)
  if (!project)
    throw new Error(`workflow cursor ${cursorId} does not exist; retry with a live cursor`)
  const payload = {
    requestId: taskFlowRequestId('delete-text', [cursorId, ...ids.sort()]),
    stageRecordId: cursorId,
    ids,
  }
  const hosted = await writeHostedTaskFlow(
    'delete-text',
    payload,
    taskFlowWriteTarget(project, d),
    client,
  )
  writeTransaction(() => taskFlowStore(d).write('delete-text', payload, hosted), d)
}
