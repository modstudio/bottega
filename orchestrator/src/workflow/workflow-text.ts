// concern: workflows
/** Owns cursor-local text attachments and the pure decisions governing their lifetime. */
import type { Database } from 'bun:sqlite'
import { writableDb, writeTransaction } from '../database/db.ts'
import { assertOrchestratorProse } from '../prose-service.ts'
import { writeHostedTaskFlow } from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import { resolveTaskFlowDestination } from './task-flow-hosted-destination.ts'
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
  return d
    .query<
      {
        id: string
        cursor_record_id: string
        step_ordinal: number
        step_slug: string
        body: string
      },
      [string]
    >(
      `SELECT record_id id,cursor_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE cursor_record_id=? ORDER BY step_ordinal,rowid`,
    )
    .all(cursorId)
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
  createdAt: string,
  d: Database,
): string {
  const existing = d
    .query<
      { cursor_record_id: string; step_ordinal: number; step_slug: string; body: string },
      [string]
    >(
      'SELECT cursor_record_id,step_ordinal,step_slug,body FROM workflow_step_text WHERE record_id=?',
    )
    .get(recordId)
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
  const inserted = d
    .query<{ id: string }, [string, string, number, string, string, string]>(
      `INSERT INTO workflow_step_text(record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,?,?,?,?,?) RETURNING record_id id`,
    )
    .get(recordId, row.record_id, row.ordinal + 1, row.step_slug, body, createdAt)
  if (!inserted) throw new Error('workflow text was not attached; retry the attach call')
  return workflowTextAttachmentToken(inserted.id)
}

async function attachWorkflowTextByHandleUnchecked(
  cursor: number,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): Promise<string> {
  const row = selectWorkflowCursor({}, cursor, undefined, d) as AttachCursorRow
  const recordId = taskFlowRequestId('attach-text', [
    row.record_id,
    String(row.ordinal + 1),
    row.step_slug,
    body,
  ])
  const createdAt = row.updated_at
  const destination = await resolveTaskFlowDestination(row.project, d, context.taskFlowClient)
  await writeHostedTaskFlow(
    'attach-text',
    {
      requestId: taskFlowRequestId('attach-text', [recordId]),
      rows: [
        {
          id: recordId,
          stageRecordId: row.record_id,
          stepOrdinal: row.ordinal + 1,
          stepSlug: row.step_slug,
          body,
          createdAt,
        },
      ],
    },
    destination,
    context.taskFlowClient,
  )
  return writeTransaction(() => {
    const current = selectWorkflowCursor({}, cursor, undefined, d) as AttachCursorRow
    if (current.record_id !== row.record_id || current.revision !== row.revision)
      throw new Error(`cursor ${cursor} changed while text was attached; rerun the attach command`)
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
  const recordId = taskFlowRequestId('attach-text', [
    row.record_id,
    String(row.ordinal + 1),
    row.step_slug,
    body,
  ])
  const createdAt = row.updated_at
  const destination = await resolveTaskFlowDestination(row.project, d, context.taskFlowClient)
  await writeHostedTaskFlow(
    'attach-text',
    {
      requestId: taskFlowRequestId('attach-text', [recordId]),
      rows: [
        {
          id: recordId,
          stageRecordId: row.record_id,
          stepOrdinal: row.ordinal + 1,
          stepSlug: row.step_slug,
          body,
          createdAt,
        },
      ],
    },
    destination,
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
  const rowIds = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM workflow_step_text WHERE cursor_record_id=?',
    )
    .all(cursorId)
    .map((row) => row.record_id)
  const copiedIds = new Set(
    d
      .query<{ workflow_text_record_id: string }, [string]>(
        'SELECT workflow_text_record_id FROM workflow_text_copy WHERE cursor_record_id=?',
      )
      .all(cursorId)
      .map((row) => row.workflow_text_record_id),
  )
  const deletable = workflowTextIdsToDelete({ linked, rowIds, copiedIds })
  return deletable
}

export function deleteWorkflowTextLocally(ids: readonly string[], d: Database): void {
  const remove = d.query('DELETE FROM workflow_step_text WHERE record_id=?')
  for (const id of ids) remove.run(id)
}

export async function deleteWorkflowText(
  cursorId: string,
  linked: boolean,
  d: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
): Promise<void> {
  const ids = workflowTextDeletionIds(cursorId, linked, d)
  if (!ids.length) return
  const row = d
    .query<{ project: string }, [string]>('SELECT project FROM workflow_cursor WHERE record_id=?')
    .get(cursorId)
  if (!row) throw new Error(`workflow cursor ${cursorId} does not exist; retry with a live cursor`)
  const destination = await resolveTaskFlowDestination(row.project, d, client)
  await writeHostedTaskFlow(
    'delete-text',
    {
      requestId: taskFlowRequestId('delete-text', [cursorId, ...ids.sort()]),
      stageRecordId: cursorId,
      ids,
    },
    destination,
    client,
  )
  writeTransaction(() => deleteWorkflowTextLocally(ids, d), d)
}
