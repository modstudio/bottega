// concern: workflows
/** Owns project-scoped linking of a workflow label to its durable task identity. */

import type { Database } from 'bun:sqlite'
import { writableDb, writeTransaction } from '../database/db.ts'
import { linkWorkflowQuestionsTaskReference } from '../run/question-mutation.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import {
  resolveWorkflowCursorMode,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'

export function linkWorkflowTaskLabel(
  database: Database,
  input: { project: string; workflowKey: string; taskRecordId: string },
): { workflow_cursor: number; question: number } {
  const cursors = database
    .query(
      `UPDATE workflow_cursor SET task_record_id=?
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_key=? AND task_record_id IS NULL`,
    )
    .run(input.taskRecordId, input.project, input.workflowKey).changes
  const questions = linkWorkflowQuestionsTaskReference(input, database)
  return { workflow_cursor: cursors, question: questions }
}

export function linkResolvedWorkflowTask(
  project: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
): void {
  const workflowKey = workflowKeyOf(args)
  if (!workflowKey || !context.taskRecordId) return
  linkWorkflowTaskLabel(database, { project, workflowKey, taskRecordId: context.taskRecordId })
}

export function withLinkedWorkflowTask<T>(
  project: string,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  database: Database,
  action: () => T,
): T {
  return writeTransaction(() => {
    linkResolvedWorkflowTask(project, args, context, database)
    return action()
  }, database)
}

/** Resolves a mode after applying the one-key rollout link in the cursor transaction. */
export function resolveLinkedWorkflowCursorMode(
  slug: string,
  project: string,
  requested: string | undefined,
  args: Record<string, string>,
  context: WorkflowCursorContext,
  caller: string,
  remedy: string,
  database: Database = writableDb(),
  cursor?: number,
): string {
  return withLinkedWorkflowTask(project, args, context, database, () =>
    resolveWorkflowCursorMode(
      slug,
      project,
      requested,
      args,
      context,
      caller,
      remedy,
      database,
      cursor,
    ),
  )
}
