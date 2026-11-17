// concern: typed question-store reads
/** Gives callers named, typed reads while the wire contract stays discriminated. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import { questionStore } from './question-store.ts'

export async function questionById(
  database: Database,
  id: string,
): Promise<Record<string, unknown> | null> {
  return (
    ((await questionStore(database).read({ read: 'by-id', ids: [id] })).items[0] as
      | Record<string, unknown>
      | undefined) ?? null
  )
}

export async function waitingQuestions(database: Database): Promise<TaskFlowWaitingQuestionRow[]> {
  return (await questionStore(database).read({ read: 'waiting' }))
    .items as TaskFlowWaitingQuestionRow[]
}

export async function openQuestionStages(
  database: Database,
  sessionId: string,
): Promise<TaskFlowOpenSessionStageRow[]> {
  return (await questionStore(database).read({ read: 'open-for-session', sessionId }))
    .items as TaskFlowOpenSessionStageRow[]
}

export async function inboxWorkflowQuestions(
  database: Database,
): Promise<TaskFlowInboxQuestionRow[]> {
  const items = (await questionStore(database).read({ read: 'inbox' })).items
  return items.filter((row) => 'cursor_record_id' in row) as TaskFlowInboxQuestionRow[]
}

export async function inboxRunQuestions(database: Database): Promise<Record<string, unknown>[]> {
  const items = (await questionStore(database).read({ read: 'inbox' })).items
  return items.filter((row) => 'run_record_id' in row) as Record<string, unknown>[]
}

export async function questionsForRun(
  database: Database,
  runId: string,
): Promise<Record<string, unknown>[]> {
  return (await questionStore(database).read({ read: 'for-run', runId })).items as Record<
    string,
    unknown
  >[]
}

export async function questionsForRuns(
  database: Database,
  runIds: readonly string[],
): Promise<Record<string, unknown>[]> {
  return (await Promise.all(runIds.map((runId) => questionsForRun(database, runId)))).flat()
}

export async function questionsForWorkflowCursor(
  database: Database,
  cursorId: string,
): Promise<Record<string, unknown>[]> {
  return (
    await questionStore(database).read({
      read: 'for-cursor',
      workflowCursorRecordId: cursorId,
    })
  ).items as Record<string, unknown>[]
}

export async function questionForWorkflowCursorByNumber(
  database: Database,
  cursorId: string,
  number: number,
): Promise<Record<string, unknown> | null> {
  return questionByNumber(await questionsForWorkflowCursor(database, cursorId), number)
}

/** Numbers are unique only within a record space, so a cursor spanning spaces can repeat one. */
export function questionByNumber<Row extends { number?: unknown }>(
  questions: Row[],
  number: number,
): Row | null {
  const matches = questions.filter((row) => row.number === number)
  if (matches.length > 1)
    throw new Error(
      `question ${number} names ${matches.length} questions on this cursor in different record spaces; close the stale one with 'bottega question close <record id> --reason <why>', then retry`,
    )
  return matches[0] ?? null
}

export async function questionRuleAuditReasons(
  database: Database,
  workflowCursorRecordId: string,
  actorSession: string,
): Promise<Array<string | null>> {
  const result = await questionStore(database).read({
    read: 'rule-audit-reasons',
    workflowCursorRecordId,
    actorSession,
  })
  return result.items.map((row) => ('reason' in row ? (row.reason as string | null) : null))
}

export async function maximumQuestionNumber(database: Database): Promise<number> {
  const row = (await questionStore(database).read({ read: 'max-number' })).items[0]
  return row && 'number' in row ? Number(row.number) : 0
}

export async function openQuestionsForCursors(
  database: Database,
  workflowCursorRecordIds: string[],
): Promise<Array<{ workflow_cursor_record_id: string; number: number }>> {
  const rows: Array<{ workflow_cursor_record_id: string; number: number }> = []
  for (let offset = 0; offset < workflowCursorRecordIds.length; offset += 100) {
    const ids = workflowCursorRecordIds.slice(offset, offset + 100)
    if (!ids.length) continue
    rows.push(
      ...((
        await questionStore(database).read({
          read: 'open-for-cursors',
          workflowCursorRecordIds: ids,
        })
      ).items as Array<{ workflow_cursor_record_id: string; number: number }>),
    )
  }
  return rows
}

export async function questionsById(
  database: Database,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  if (!ids.length) return []
  return (await questionStore(database).read({ read: 'by-id', ids })).items as Record<
    string,
    unknown
  >[]
}

export async function questionRulings(
  database: Database,
  input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    limit?: number
    changedAfter?: string
  },
) {
  const result = await questionStore(database).read({ read: 'rulings', ...input })
  return { ...result, items: result.items as Record<string, unknown>[] }
}

export async function questionTaskRulings(
  database: Database,
  projectId: string,
  taskId: string,
  limit?: number,
): Promise<TaskFlowTaskRulingRow[]> {
  return (await questionStore(database).read({ read: 'task-rulings', projectId, taskId, limit }))
    .items as TaskFlowTaskRulingRow[]
}

export async function questionProjects(
  database: Database,
): Promise<Array<{ project: string | null }>> {
  return (await questionStore(database).read({ read: 'projects' })).items as Array<{
    project: string | null
  }>
}
