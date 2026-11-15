// concern: hosted-question-read
/** Reads question-owned facts and their hosted run, stage, task, and project owners. */

import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import type { QuestionReadInput } from './record-question-contract.ts'

type Tenant = { url: string } & TenantPrincipal

const select = `
  SELECT q.id::text,q.number,q.run_id::text,q.workflow_cursor_record_id::text,
         q.workflow_key,q.workflow_task_id::text,q.project_id::text,
         q.asked_at::text,q.question,q.options,q.recommendation,q.why,q.asked_via,q.kind,
         q.typed_options,q.criteria,q.levels,q.answer,q.answer_value,q.answer_basis,
         q.answered_at::text,q.answered_by,q.answered_by_name,q.answered_by_kind,
         q.answerer_kind,q.answer_channel,q.awaiting_operator_at::text,q.relayed_by,
         q.overturned_at::text,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement,
         q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text,
         q.closed_at::text,q.close_reason,q.created_at::text,q.updated_at::text,
         owner.number AS run_number,owner.parent_run_id::text,owner.agent,owner.job,
         owner.status AS run_status,owner.session_id AS run_session_id,
         root.id::text AS root_run_id,root.number AS root_run_number,root.status AS root_run_status,
         root.task_id::text AS run_task_id,
         stage.number AS workflow_cursor_number,stage.project_id::text AS stage_project_id,
         stage.workflow,stage.mode,stage.arguments,stage.active_ordinal,stage.active_slug,
         stage.state AS stage_state,stage.session_id AS stage_session_id,
         COALESCE(run_project.id,stage_project.id,q.project_id)::text AS owner_project_id,
         COALESCE(run_project.name,stage_project.name,direct_project.name) AS project
    FROM question q
    LEFT JOIN run owner ON owner.id=q.run_id
    LEFT JOIN run root ON root.id=COALESCE(owner.parent_run_id,owner.id)
    LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
    LEFT JOIN project run_project ON run_project.id=root.project_id
    LEFT JOIN project stage_project ON stage_project.id=stage.project_id
    LEFT JOIN project direct_project ON direct_project.id=q.project_id`

async function rows(tx: SQL, input: QuestionReadInput): Promise<Record<string, unknown>[]> {
  if (input.read === 'projects')
    return (await tx.unsafe(
      `SELECT DISTINCT owner_project_id,project FROM (${select}) questions
        WHERE owner_project_id IS NOT NULL ORDER BY project`,
    )) as Record<string, unknown>[]
  const clauses: string[] = []
  const values: unknown[] = []
  if (input.read === 'waiting' || input.read === 'open-for-session')
    clauses.push('q.answered_at IS NULL', 'q.closed_at IS NULL')
  if (input.read === 'open-for-session') {
    values.push(input.sessionId)
    clauses.push(`(owner.session_id=$${values.length} OR stage.session_id=$${values.length})`)
  }
  if (input.read === 'rulings') {
    if (input.kind === 'workflow') clauses.push('q.workflow_cursor_record_id IS NOT NULL')
    if (input.kind === 'run') clauses.push('q.run_id IS NOT NULL')
    if (input.since) {
      values.push(input.since)
      clauses.push(
        `(q.answered_at >= $${values.length}::timestamptz OR q.closed_at >= $${values.length}::timestamptz OR q.overturned_at >= $${values.length}::timestamptz OR q.filed_at >= $${values.length}::timestamptz OR (q.answered_at IS NULL AND q.closed_at IS NULL))`,
      )
    }
  }
  if (input.read === 'task-rulings') {
    values.push(input.projectId, input.taskId)
    clauses.push(`COALESCE(root.project_id,stage.project_id,q.project_id)=$1::uuid`)
    clauses.push(`(root.task_id=$2::uuid OR q.workflow_task_id=$2::uuid)`)
    clauses.push('q.answered_at IS NOT NULL')
    clauses.push('NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)')
  }
  const limit = input.limit ?? 100
  values.push(limit)
  return (await tx.unsafe(
    `${select} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY COALESCE(q.overturned_at,q.answered_at,q.asked_at) DESC,q.number DESC
      LIMIT $${values.length}`,
    values,
  )) as Record<string, unknown>[]
}

export async function readRecordQuestions(
  input: Tenant & QuestionReadInput,
): Promise<{ items: Record<string, unknown>[] }> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return { items: await rows(tx, input) }
  })
}
