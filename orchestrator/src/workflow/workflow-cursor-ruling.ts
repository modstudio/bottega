// concern: workflow cursor ruling
/** Applies one hosted-first ruling to a waiting workflow cursor and its local question. */

import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { assertOrchestratorProse } from '../prose-service.ts'
import {
  openQuestionOnStep,
  questionsForWorkflowCursor,
} from '../question-store/question-store-read.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import type { TaskFlowIntentResult } from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import {
  answerWorkflowQuestion,
  authorizeWorkflowQuestionMutation,
} from '../run/question-mutation.ts'
import { resolvedRulingPersonName } from '../run/ruling-attribution.ts'
import { taskFlowLocalStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorName } from './workflow-cursor-format.ts'
import {
  findWorkflowCursor,
  type SelectableCursorRow,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { cursorOwnerAfter } from './workflow-cursor-transition.ts'
import { decideWorkflowRuleAnswer, pinnedWorkflowRuleStep } from './workflow-rule-answer.ts'
import { strandedWorkflowQuestionRemedy } from './workflow-stranded-question.ts'
import { followTaskCursorClaim } from './workflow-task-claim.ts'
import { linkResolvedWorkflowTask } from './workflow-task-linking.ts'

function selectOpenWorkflowQuestion(
  cursor: Pick<SelectableCursorRow, 'record_id' | 'ordinal' | 'step_slug'>,
  questions: Record<string, unknown>[],
): { record_id: string; number: number } | null {
  const row = openQuestionOnStep(questions, {
    ordinal: cursor.ordinal + 1,
    slug: cursor.step_slug,
  })
  return row ? { record_id: String(row.record_id), number: Number(row.number) } : null
}

export async function ruleWorkflow(
  slug: string,
  project: string,
  mode: string,
  args: Record<string, string>,
  ruling: string | undefined,
  fromOperator: boolean,
  channel: 'cli' | 'mcp',
  context: WorkflowCursorContext,
  database: Database = writableDb(),
  cursor?: number,
): Promise<{ summary: string; questionId: number; cursorRecordId: string }> {
  if (ruling?.trim())
    await assertOrchestratorProse([{ field: 'ruling text', text: ruling, prior: null }])
  if (!ruling?.trim()) throw new Error('--ruling is required')
  await linkResolvedWorkflowTask(project, context, database)
  const row = await findWorkflowCursor(project, slug, mode, args, context, database, cursor)
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, workflowKeyOf(args))} has no cursor; compose the workflow first`,
    )
  const questions = await questionsForWorkflowCursor(database, row.record_id)
  const strandedQuestion = strandedWorkflowQuestionRemedy(questions, row.state)
  if (row.state !== 'awaiting-ruling')
    throw new Error(
      `${cursorName(slug, mode, row.workflow_key)} is not awaiting a ruling${strandedQuestion ? `; ${strandedQuestion}` : ''}`,
    )
  const step = pinnedWorkflowRuleStep(row, cursorName(slug, mode, row.workflow_key), database)
  const refusal = decideWorkflowRuleAnswer({
    fromOperator,
    operatorRuling: Boolean(step.operatorRuling),
  })
  if (refusal) throw new Error(refusal)
  const actor = sessionId()
  const adoptionReason = authorizeWorkflowQuestionMutation({
    owner: row.session_id,
    actor,
    fromOperator,
    subject: cursorName(slug, mode, row.workflow_key),
    action: 'rule',
    chainLastActivityAt: Date.parse(row.updated_at),
    database,
  })
  const at = nowIso()
  const question = selectOpenWorkflowQuestion(row, questions)
  if (!question)
    throw new Error(
      `${cursorName(slug, mode, row.workflow_key)} has no open question to rule on${strandedQuestion ? `; ${strandedQuestion}` : ''}`,
    )
  await followTaskCursorClaim({
    project: row.project,
    taskKey: row.workflow_key || null,
    session: row.session_id && row.session_id !== context.session ? null : context.session,
    verb: 'rule',
    database,
  })
  const payload: TaskFlowIntentInput<'stage-update'> = {
    requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
    stages: [
      {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          state: 'running',
          question: null,
          sessionId: cursorOwnerAfter('rule', row.session_id, context.session),
          updatedAt: at,
        },
      },
    ],
  }
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(row.project, database),
    context.taskFlowClient,
  )
  return applyWorkflowRulingLocally({
    row,
    question,
    ruling: ruling.trim(),
    actor,
    fromOperator,
    channel,
    adoptionReason,
    at,
    context,
    payload,
    hosted,
    database,
  })
}

async function applyWorkflowRulingLocally(input: {
  row: SelectableCursorRow
  question: { record_id: string; number: number }
  ruling: string
  actor: string | null
  fromOperator: boolean
  channel: 'cli' | 'mcp'
  adoptionReason: string | null
  at: string
  context: WorkflowCursorContext
  payload: TaskFlowIntentInput<'stage-update'>
  hosted: TaskFlowIntentResult<'stage-update'> | null
  database: Database
}): Promise<{ summary: string; questionId: number; cursorRecordId: string }> {
  const { row, question, database } = input
  await answerWorkflowQuestion(
    {
      questionId: question.record_id,
      cursorId: row.record_id,
      ruling: input.ruling,
      at: input.at,
      actor: input.actor,
      fromOperator: input.fromOperator,
      personName: resolvedRulingPersonName(input.fromOperator),
      channel: input.channel,
      adoptionReason: input.adoptionReason,
    },
    database,
  )
  const result = writeTransaction(() => {
    const store = taskFlowLocalStore(database)
    store.write('stage-update', input.payload, input.hosted)
    return {
      summary: `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} is running at step ${row.ordinal + 1} ${row.step_slug}.`,
      questionId: question.number,
    }
  }, database)
  return { summary: result.summary, questionId: result.questionId, cursorRecordId: row.record_id }
}
