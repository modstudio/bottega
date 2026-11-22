// concern: typed question-store reads
/** Gives callers named, typed reads while the wire contract stays discriminated. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { projectByName } from '../project/project-read.ts'
import { QUESTION_ID_LIST_LIMIT } from '../record/record-question-contract.ts'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import { compareQuestionsByAsk } from './question-order.ts'
import { questionStore } from './question-store.ts'
import type { QuestionStore } from './question-store-types.ts'

export async function questionProjectSpace(
  database: Database,
  projectId: string,
): Promise<string | null> {
  return (await questionStore(database).projectSpace?.(projectId)) ?? null
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

export async function questionByProjectNumber(
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

export async function questionByUnscopedNumber(
  database: Database,
  number: number,
): Promise<Record<string, unknown> | null> {
  return (
    ((await questionStore(database).read({ read: 'by-number', number })).items[0] as
      | Record<string, unknown>
      | undefined) ?? null
  )
}

export async function openQuestionsForTasks(
  database: Database,
  taskRecordIds: string[],
  projectId?: string,
): Promise<Record<string, unknown>[]> {
  if (!taskRecordIds.length) return []
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; offset < taskRecordIds.length; offset += QUESTION_ID_LIST_LIMIT) {
    rows.push(
      ...((
        await questionStore(database).read(
          {
            read: 'open-for-tasks',
            taskRecordIds: taskRecordIds.slice(offset, offset + QUESTION_ID_LIST_LIMIT),
          },
          projectId,
        )
      ).items as Record<string, unknown>[]),
    )
  }
  return rows
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
    input.projectId ??
    (input.project ? projectByName(input.project, database)?.recordId : undefined)
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

export async function inboxQuestions(database: Database): Promise<Record<string, unknown>[]> {
  return (await questionStore(database).read({ read: 'inbox' })).items as Record<string, unknown>[]
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

export function questionOnStep(
  row: Record<string, unknown>,
  step: { ordinal: number; slug: string },
): boolean {
  return Number(row.workflow_step_ordinal) === step.ordinal && row.workflow_step_slug === step.slug
}

export function latestQuestionOnStep(
  rows: Record<string, unknown>[],
  step: { ordinal: number; slug: string },
): Record<string, unknown> | null {
  return (
    rows
      .filter((row) => questionOnStep(row, step))
      .sort((left, right) => compareQuestionsByAsk(right, left))[0] ?? null
  )
}

export function openQuestionOnStep(
  rows: Record<string, unknown>[],
  step: { ordinal: number; slug: string },
): Record<string, unknown> | null {
  return latestQuestionOnStep(
    rows.filter((row) => row.answered_at === null && row.closed_at === null),
    step,
  )
}

export async function openQuestionForWorkflowStep(
  database: Database,
  input: { cursorId: string; cursorOrdinal: number; stepSlug: string },
): Promise<Record<string, unknown> | null> {
  const questions = await questionsForWorkflowCursor(database, input.cursorId)
  return openQuestionOnStep(questions, {
    ordinal: input.cursorOrdinal + 1,
    slug: input.stepSlug,
  })
}

export async function questionForWorkflowCursorByNumber(
  database: Database,
  cursorId: string,
  number: number,
): Promise<Record<string, unknown> | null> {
  return questionByNumber(await questionsForWorkflowCursor(database, cursorId), number)
}

/** Numbers are unique only within a record space, so a cursor spanning spaces can repeat one. */
export function questionByNumber<
  Row extends { number?: unknown; answered_at?: unknown; closed_at?: unknown },
>(questions: Row[], number: number): Row | null {
  const numbered = questions.filter((row) => row.number === number)
  // A question closed without an answer is withdrawn, so closing the stale one settles the citation.
  const matches =
    numbered.length > 1
      ? numbered.filter((row) => !(row.closed_at != null && row.answered_at == null))
      : numbered
  if (matches.length > 1)
    throw new Error(
      `question ${number} names ${matches.length} questions on this cursor in different record spaces; close the stale one with '${PLATFORM_NAME} question close <record id> --reason <why>', then retry`,
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
  for (let offset = 0; offset < workflowCursorRecordIds.length; offset += QUESTION_ID_LIST_LIMIT) {
    const ids = workflowCursorRecordIds.slice(offset, offset + QUESTION_ID_LIST_LIMIT)
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
  return questionRulingsPaged(questionStore(database), kind)
}

export async function questionRulingsPaged(
  store: QuestionStore,
  kind: 'workflow' | 'run' | 'all',
): Promise<Record<string, unknown>[]> {
  const items = new Map<string, Record<string, unknown>>()
  let changedAfter: string | undefined
  let more = true
  while (more) {
    const result = await store.read({
      read: 'rulings',
      kind,
      ...(changedAfter === undefined ? { limit: 100 } : { changedAfter }),
    })
    for (const item of result.items as Record<string, unknown>[])
      items.set(item.record_id as string, item)
    more = result.more === true
    if (!more) return [...items.values()]
    if (!result.cursor)
      throw new Error('question rulings page says more without a continuation cursor')
    changedAfter = result.cursor
  }
  return [...items.values()]
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
