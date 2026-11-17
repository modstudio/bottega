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
import { questionNumberProjectId as sqliteQuestionNumberProjectId } from './question-store-sqlite-reads.ts'

function projectRecordIdByName(database: Database, project: string): string | undefined {
  return database
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM project WHERE name=? AND retired_at IS NULL',
    )
    .get(project)?.record_id
}

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

export async function questionByNumber(
  database: Database,
  number: number,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  return (
    ((await questionStore(database).read({ read: 'by-number', number }, projectId)).items[0] as
      | Record<string, unknown>
      | undefined) ?? null
  )
}

export function questionNumberProjectId(database: Database, number: number): string | null {
  return sqliteQuestionNumberProjectId(database, number)
}

export async function openQuestionsForTasks(
  database: Database,
  taskRecordIds: string[],
  projectId: string,
): Promise<Record<string, unknown>[]> {
  if (!taskRecordIds.length) return []
  return (await questionStore(database).read({ read: 'open-for-tasks', taskRecordIds }, projectId))
    .items as Record<string, unknown>[]
}

export async function questionsForSession(database: Database, sessionId: string) {
  return (await questionStore(database).read({ read: 'for-session', sessionId })).items as Record<
    string,
    unknown
  >[]
}

export async function unlinkedWorkflowQuestions(
  database: Database,
  input: { project?: string; workflowKey?: string; projectId?: string } = {},
) {
  const projectId =
    input.projectId ?? (input.project ? projectRecordIdByName(database, input.project) : undefined)
  return (
    await questionStore(database).read(
      { read: 'unlinked-workflow', project: input.project, workflowKey: input.workflowKey },
      projectId,
    )
  ).items as Record<string, unknown>[]
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
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; offset < runIds.length; offset += 100) {
    const ids = runIds.slice(offset, offset + 100)
    if (!ids.length) continue
    rows.push(
      ...((await questionStore(database).read({ read: 'for-runs', runIds: ids })).items as Record<
        string,
        unknown
      >[]),
    )
  }
  return rows
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
  const questions = await questionsForWorkflowCursor(database, cursorId)
  return questions.find((row) => row.number === number) ?? null
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

export async function allQuestionRulingsPaged(
  database: Database,
  kind: 'workflow' | 'run' | 'all',
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  let changedAfter: string | undefined
  let more = true
  while (more) {
    const result = await questionRulings(database, {
      kind,
      ...(changedAfter === undefined ? { limit: 100 } : { changedAfter }),
    })
    items.push(...result.items)
    more = result.more === true
    if (!more) return items
    if (!result.cursor)
      throw new Error('question rulings page says more without a continuation cursor')
    changedAfter = result.cursor
  }
  return items
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
