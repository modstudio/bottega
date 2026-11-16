// concern: typed question-store reads
/** Gives callers named, typed reads while the wire contract stays discriminated. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowInboxQuestionRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowRulingFileRow,
  TaskFlowTaskRulingRow,
  TaskFlowWaitingQuestionRow,
} from '../workflow/task-flow-store-types.ts'
import { questionStore } from './question-store.ts'

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

export async function questionsForChain(
  database: Database,
  rootId: string,
): Promise<Record<string, unknown>[]> {
  const runIds = database
    .query<{ record_id: string }, [string, string]>(
      'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number',
    )
    .all(rootId, rootId)
    .map(({ record_id }) => record_id)
  return (await Promise.all(runIds.map((runId) => questionsForRun(database, runId)))).flat()
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

export async function questionForFiling(
  database: Database,
  questionId: string,
): Promise<TaskFlowRulingFileRow | null> {
  return (
    ((await questionStore(database).read({ read: 'by-id', ids: [questionId] })).items[0] as
      | TaskFlowRulingFileRow
      | undefined) ?? null
  )
}
