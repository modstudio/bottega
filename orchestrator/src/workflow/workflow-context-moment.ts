// concern: workflows
/** Gathers the plain post-advance cursor values consumed by context moment policy. */
import type { Database } from 'bun:sqlite'
import { type ContextMomentEffect, contextMomentEffect } from '../../../shared/context-moment.ts'
import { db } from '../database/db.ts'
import { taskFlowStore } from './task-flow-store.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import {
  type SelectableCursorRow,
  selectWorkflowCursorForClose,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'

export type WorkflowContextMoment = { taskKey: string | null; effect: ContextMomentEffect }

export function workflowQuestionContextMoment(input: {
  moment: 'workflow-await' | 'workflow-rule'
  taskKey?: string
  questionId: number
  text: string
  operatorRuled?: boolean
}): WorkflowContextMoment {
  return { taskKey: input.taskKey ?? null, effect: contextMomentEffect(input) }
}

export function selectWorkflowContextCursor(input: {
  project: string
  workflow: string
  mode: string
  args: Record<string, string>
  cursor?: number
  context: WorkflowCursorContext
}): SelectableCursorRow {
  const row = selectWorkflowCursorForClose(
    {
      project: input.project,
      workflow: input.workflow,
      mode: input.mode,
      key: workflowKeyOf(input.args) || undefined,
    },
    input.cursor,
    input.context.session,
    db(),
    input.context.taskRecordId,
    input.context.taskStatusCategory,
  )
  if (!row) throw new Error(`workflow ${input.workflow} has no cursor; compose the workflow first`)
  return row
}

export function workflowNextContextMoment(
  cursorRecordId: string,
  selfRuling?: string,
  database: Database = db(),
): WorkflowContextMoment {
  const row = taskFlowStore(database).stageByRecordId(cursorRecordId) as SelectableCursorRow | null
  if (!row) throw new Error(`workflow cursor ${cursorRecordId} no longer exists`)
  const step = row.state === 'done' ? null : cursorComposition(row, database).steps[row.ordinal]
  const question =
    selfRuling === undefined
      ? null
      : database
          .query<{ number: number }, [string, string]>(
            `SELECT number FROM question
             WHERE workflow_cursor_record_id=? AND answer=?
             ORDER BY number DESC LIMIT 1`,
          )
          .get(row.record_id, selfRuling)
  if (selfRuling !== undefined && !question)
    throw new Error('the recorded self-ruling has no question id')
  const taskKey = row.workflow_key || null
  return {
    taskKey,
    effect: contextMomentEffect({
      moment: 'workflow-next',
      taskKey,
      questionId: question?.number,
      text: selfRuling,
      cursor: {
        workflow: row.workflow_slug,
        number: row.id,
        stepSlug: step?.slug,
        stepTitle: step?.title,
        finished: row.state === 'done',
      },
    }),
  }
}
