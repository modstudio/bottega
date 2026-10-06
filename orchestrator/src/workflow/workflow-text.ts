// concern: workflows
/** Owns cursor-local text attachments and the pure decisions governing their lifetime. */
import type { Database } from 'bun:sqlite'
import { nowIso, writableDb, writeTransaction } from '../database/db.ts'
import type { WorkflowFactSource } from '../project/project-injection.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { selectWorkflowCursor } from './workflow-cursor-selection.ts'
import type { CursorState } from './workflow-cursor-transition.ts'

export const WORKFLOW_TEXT_ATTACHMENT_MAX_BYTES = 32 * 1024
export const WORKFLOW_TEXT_CURSOR_MAX_BYTES = 64 * 1024

export type WorkflowTextRow = {
  id: number
  cursorId: number
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
  cursorId: number
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
  needs: readonly WorkflowFactSource[],
  rows: readonly WorkflowTextRow[],
): { workflowText: { stepSlug: string; body: string }[] } | Record<string, never> {
  if (!needs.includes('workflow-text')) return {}
  return {
    workflowText: [...rows]
      .sort((left, right) => left.stepOrdinal - right.stepOrdinal || left.id - right.id)
      .map(({ stepSlug, body }) => ({ stepSlug, body })),
  }
}

export function workflowTextRows(cursorId: number, d: Database): WorkflowTextRow[] {
  return d
    .query<
      { id: number; cursor_id: number; step_ordinal: number; step_slug: string; body: string },
      [number]
    >(
      `SELECT id,cursor_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE cursor_id=? ORDER BY step_ordinal,id`,
    )
    .all(cursorId)
    .map((row) => ({
      id: row.id,
      cursorId: row.cursor_id,
      stepOrdinal: row.step_ordinal,
      stepSlug: row.step_slug,
      body: row.body,
    }))
}

type AttachCursorRow = {
  id: number
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
}

function attachSelectedWorkflowText(
  row: AttachCursorRow,
  body: string,
  context: WorkflowCursorContext,
  d: Database,
): string {
  const attachmentBytes = Buffer.byteLength(body, 'utf8')
  const cursorBytes = workflowTextRows(row.id, d).reduce(
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
    .query<{ id: number }, [number, number, string, string, string]>(
      `INSERT INTO workflow_step_text(cursor_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(row.id, row.ordinal + 1, row.step_slug, body, nowIso())
  if (!inserted) throw new Error('workflow text was not attached; retry the attach call')
  return `attached-text:${inserted.id}`
}

export function attachWorkflowTextByHandle(
  cursor: number,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): string {
  return writeTransaction(() => {
    const row = selectWorkflowCursor({}, cursor, undefined, d) as AttachCursorRow
    return attachSelectedWorkflowText(row, body, context, d)
  }, d)
}

export function attachWorkflowText(
  identity: { project: string; workflow: string; mode: string; key?: string },
  cursor: number | undefined,
  body: string,
  context: WorkflowCursorContext,
  d: Database = writableDb(),
): string {
  return writeTransaction(() => {
    const row = selectWorkflowCursor(identity, cursor, context.session, d) as AttachCursorRow | null
    if (!row) throw new Error('workflow has no live cursor; fetch its current step first')
    return attachSelectedWorkflowText(row, body, context, d)
  }, d)
}

export function deleteWorkflowText(cursorId: number, d: Database): void {
  d.query('DELETE FROM workflow_step_text WHERE cursor_id=?').run(cursorId)
}
