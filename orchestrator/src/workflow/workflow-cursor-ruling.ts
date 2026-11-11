// concern: workflow cursor ruling
/** Applies one hosted-first ruling to a waiting workflow cursor and its local question. */

import type { Database } from 'bun:sqlite'
import { nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { assertOrchestratorProse } from '../prose-service.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import {
  answerWorkflowQuestion,
  authorizeWorkflowQuestionMutation,
} from '../run/question-mutation.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { resolvedRulingPersonName } from '../run/ruling-attribution.ts'
import { workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorName } from './workflow-cursor-format.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import { findWorkflowCursor, type WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { decideWorkflowRuleAnswer, pinnedWorkflowRuleStep } from './workflow-rule-answer.ts'
import { linkResolvedWorkflowTask } from './workflow-task-linking.ts'

function selectOpenWorkflowQuestion(
  cursorRecordId: string,
  database: Database,
): { record_id: string; number: number } | null {
  return database
    .query<{ record_id: string; number: number }, [string]>(
      `SELECT record_id,number FROM question
       WHERE workflow_cursor_record_id=? AND ${questionOpenSql('question')}`,
    )
    .get(cursorRecordId)
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
): Promise<{ summary: string; questionId: number }> {
  if (ruling?.trim())
    await assertOrchestratorProse([{ field: 'ruling text', text: ruling, prior: null }])
  if (!ruling?.trim()) throw new Error('--ruling is required')
  await linkResolvedWorkflowTask(project, context, database)
  const row = findWorkflowCursor(
    project,
    slug,
    mode,
    args,
    context,
    database,
    cursor,
  ) as WorkflowCloseCursor | null
  if (!row)
    throw new Error(
      `${cursorName(slug, mode, workflowKeyOf(args))} has no cursor; compose the workflow first`,
    )
  if (row.state !== 'awaiting-ruling')
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} is not awaiting a ruling`)
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
  const question = selectOpenWorkflowQuestion(row.record_id, database)
  if (!question)
    throw new Error(`${cursorName(slug, mode, row.workflow_key)} has no open question to rule on`)
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    {
      requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
      stages: [
        {
          id: row.record_id,
          expectedRevision: row.revision,
          values: {
            state: 'running',
            question: null,
            sessionId: row.session_id ?? context.session ?? null,
            updatedAt: at,
          },
        },
      ],
    },
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
    revision: hosted?.revisions[row.record_id] ?? row.revision + 1,
    database,
  })
}

function applyWorkflowRulingLocally(input: {
  row: WorkflowCloseCursor
  question: { record_id: string; number: number }
  ruling: string
  actor: string | null
  fromOperator: boolean
  channel: 'cli' | 'mcp'
  adoptionReason: string | null
  at: string
  context: WorkflowCursorContext
  revision: number
  database: Database
}): { summary: string; questionId: number } {
  const { row, question, database } = input
  return writeTransaction(() => {
    const current = database
      .query<{ revision: number }, [string]>(
        'SELECT revision FROM workflow_cursor WHERE record_id=?',
      )
      .get(row.record_id)
    if (!current || current.revision !== row.revision)
      throw new Error(
        `workflow cursor ${row.id} changed while its ruling was recorded; rerun the command`,
      )
    answerWorkflowQuestion(
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
    database
      .query(
        `UPDATE workflow_cursor SET state='running',question=NULL,
         session_id=COALESCE(session_id,?),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=? WHERE record_id=?`,
      )
      .run(
        input.context.session ?? null,
        input.at,
        machineId(),
        machineId(),
        input.revision,
        row.record_id,
      )
    return {
      summary: `${cursorName(row.workflow_slug, row.mode_slug, row.workflow_key, true)} is running at step ${row.ordinal + 1} ${row.step_slug}.`,
      questionId: question.number,
    }
  }, database)
}
