// concern: workflows
/** Owns project-scoped linking of a workflow label to its durable hub task identity. */

import type { Database } from 'bun:sqlite'
import { linkWorkflowQuestionsTaskReference } from '../run/question-mutation.ts'

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
