// concern: workflow-cursor-mutation
/** Persists terminal cursor mutations and their task-flow projection. */
import type { Database } from 'bun:sqlite'
import { sessionId } from '../database/db.ts'
import { closeQuestions } from '../run/question-close.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { closeTaskFlowStage, recordTaskFlowCursorMutation } from './task-flow.ts'
import { cursorName } from './workflow-cursor-format.ts'
import { refuseTerminalCursor } from './workflow-cursor-result.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import type { WorkflowCursorContext } from './workflow-cursor-selection.ts'
import type { CursorTrailEntry } from './workflow-cursor-trail.ts'
import { deleteWorkflowText } from './workflow-text.ts'

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

export function abandonWorkflowCursor(
  row: WorkflowCloseCursor,
  reason: string,
  context: WorkflowCursorContext,
  d: Database,
): string {
  refuseTerminalCursor(row)
  const at = new Date().toISOString()
  if (row.state === 'awaiting-ruling') closeOpenWorkflowQuestion(row.record_id, 'abandoned', at, d)
  const closed = JSON.parse(row.closed) as CursorTrailEntry[]
  closed.push({
    n: row.ordinal + 1,
    slug: row.step_slug,
    note: `abandoned: ${reason.trim()}`,
    at,
  })
  d.query(
    `UPDATE workflow_obligation SET abandoned_at=?,abandoned_reason=?
     WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL`,
  ).run(at, reason.trim(), row.record_id)
  deleteWorkflowText(row.record_id, Boolean(row.task_record_id), d)
  d.query(
    `UPDATE workflow_cursor SET state='abandoned',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
  ).run(JSON.stringify(closed), context.session ?? null, at, row.record_id)
  recordTaskFlowCursorMutation(row.record_id, d)
  closeTaskFlowStage(row.record_id, d)
  return `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} was abandoned at step ${row.ordinal + 1} ${row.step_slug}.`
}

export function finishWorkflowCursor(
  row: WorkflowCloseCursor,
  closed: CursorTrailEntry[],
  context: WorkflowCursorContext,
  at: string,
  d: Database,
): void {
  d.query(
    `UPDATE workflow_cursor SET state='done',closed=?,question=NULL,
     session_id=COALESCE(?,session_id),updated_at=? WHERE record_id=?`,
  ).run(JSON.stringify(closed), context.session ?? null, at, row.record_id)
  recordTaskFlowCursorMutation(row.record_id, d)
  closeTaskFlowStage(row.record_id, d)
}
