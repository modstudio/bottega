// concern: hosted-question-read
/** Reads question-owned facts in the same row shapes as the local question reads. */
import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import type { QuestionReadInput } from './record-question-contract.ts'

type Tenant = { url: string } & TenantPrincipal
type Row = Record<string, unknown>

async function rows(tx: SQL, input: QuestionReadInput): Promise<Row[]> {
  const limit = input.limit ?? 100
  if (input.read === 'inbox') {
    const runs = (await tx.unsafe(
      `SELECT q.number,q.id::text record_id,q.run_id::text run_record_id,owner.number run_number,
        q.asked_at::text,q.question,q.options::text,q.recommendation,q.why,q.kind,q.jev_pick,q.jev_confidence,
        q.jev_probabilities::text,q.jev_error,q.answered_at::text,q.overturned_at::text,q.overturned_by,
        q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text,
        owner.agent,owner.job,NULL::text repo,root.project_id::text project_record_id,owner.status,owner.session_id,
        root.status root_status,root.id::text root_record_id,root.number root_number,
        CASE WHEN root.evidence_excluded IS NULL THEN 0 ELSE 1 END root_voided,
        COALESCE(owner.parent_run_id,owner.id)::text root_id
       FROM question q JOIN run owner ON owner.id=q.run_id
       JOIN run root ON root.id=COALESCE(owner.parent_run_id,owner.id)
       WHERE q.closed_at IS NULL ORDER BY q.run_id,q.number LIMIT $1`,
      [limit],
    )) as Row[]
    const workflows = (await tx.unsafe(
      `SELECT q.number,q.id::text record_id,q.asked_at::text,q.question,stage.number cursor_record_id,
        project.name project,stage.project_id::text project_record_id,stage.workflow workflow_slug,
        stage.mode mode_slug,stage.arguments::text args,stage.active_ordinal ordinal,
        stage.active_slug step_slug,stage.session_id
       FROM question q JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
       JOIN project ON project.id=stage.project_id
       WHERE stage.state='awaiting-ruling' AND q.answered_at IS NULL AND q.closed_at IS NULL
       ORDER BY q.asked_at,q.number LIMIT $1`,
      [limit],
    )) as Row[]
    return [...runs, ...workflows].slice(0, limit)
  }
  if (input.read === 'waiting')
    return (await tx.unsafe(
      `SELECT stage.number id,stage.id::text workflow_cursor_record_id,project.name project,
        q.id::text question_record_id,q.workflow_key task_key,q.question,q.asked_at::text waiting_since,
        stage.workflow workflow_slug,stage.mode mode_slug,stage.arguments::text args,stage.session_id
       FROM task_flow_stage stage JOIN question q ON q.workflow_cursor_record_id=stage.id
       JOIN project ON project.id=stage.project_id
       WHERE stage.state='awaiting-ruling' AND q.answered_at IS NULL AND q.closed_at IS NULL
       ORDER BY q.asked_at,q.number LIMIT $1`,
      [limit],
    )) as Row[]
  if (input.read === 'open-for-session')
    return (await tx.unsafe(
      `SELECT stage.id::text record_id,stage.number,project.name project,stage.workflow workflow_slug,
        stage.mode mode_slug,stage.workflow_key,stage.state,stage.updated_at::text updated_at,
        (SELECT q.id::text FROM question q WHERE q.workflow_cursor_record_id=stage.id
          AND q.answered_at IS NULL AND q.closed_at IS NULL LIMIT 1) open_question_record_id
       FROM task_flow_stage stage JOIN project ON project.id=stage.project_id
       WHERE stage.session_id=$1 AND stage.state NOT IN ('done','abandoned')
       ORDER BY stage.number LIMIT $2`,
      [input.sessionId, limit],
    )) as Row[]
  if (input.read === 'rulings') {
    const clauses: string[] = []
    const values: unknown[] = []
    if (input.kind === 'workflow') clauses.push('q.workflow_cursor_record_id IS NOT NULL')
    else if (input.kind === 'run') clauses.push('q.run_id IS NOT NULL')
    if (input.since) {
      values.push(input.since)
      const at = `$${values.length}::timestamptz`
      clauses.push(
        `(q.answered_at IS NULL AND q.closed_at IS NULL OR q.asked_at>=${at} OR q.answered_at>=${at} OR q.closed_at>=${at} OR q.overturned_at>=${at} OR q.filed_at>=${at})`,
      )
    }
    values.push(limit)
    return (await tx.unsafe(
      `SELECT q.number,q.id::text record_id,q.run_id::text run_record_id,owner.number run_number,
        q.workflow_cursor_record_id::text workflow_cursor_id,q.workflow_key,
        COALESCE(run_project.name,stage_project.name) project,stage.workflow workflow_slug,stage.mode mode_slug,
        COALESCE(owner.session_id,stage.session_id) session_id,q.asked_at::text,q.question,q.answer,q.answer_basis,
        q.answered_at::text,q.answered_by,q.answered_by_name,q.asked_via,q.answerer_kind,q.answer_channel,
        q.closed_at::text,q.close_reason,q.overturned_at::text,q.overturned_by,q.overturned_by_name,
        q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text
       FROM question q LEFT JOIN run owner ON owner.id=q.run_id
       LEFT JOIN project run_project ON run_project.id=owner.project_id
       LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
       LEFT JOIN project stage_project ON stage_project.id=stage.project_id
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY q.number LIMIT $${values.length}`,
      values,
    )) as Row[]
  }
  if (input.read === 'task-rulings')
    return (await tx.unsafe(
      `WITH raw_candidates AS (
       SELECT q.number question_id,q.id::text question_record_id,root.id::text run_record_id,
        NULL::text workflow_cursor_record_id,q.question,q.answer,q.answer_basis,q.answered_at::text,
        q.answerer_kind,q.answered_by_name,q.overturned_at::text,q.overturned_by_name,q.replacement,
        COALESCE(q.overturned_at,q.answered_at) effective_at
       FROM question q JOIN run owner ON owner.id=q.run_id JOIN run root ON root.id=COALESCE(owner.parent_run_id,owner.id)
       WHERE root.project_id=$1::uuid AND root.task_id=$2::uuid AND q.answered_at IS NOT NULL
        AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)
       UNION ALL
       SELECT q.number,q.id::text,NULL::text,q.workflow_cursor_record_id::text,q.question,q.answer,q.answer_basis,
        q.answered_at::text,q.answerer_kind,q.answered_by_name,q.overturned_at::text,q.overturned_by_name,q.replacement,
        COALESCE(q.overturned_at,q.answered_at)
       FROM question q JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
       WHERE stage.project_id=$1::uuid AND q.workflow_task_id=$2::uuid AND q.answered_at IS NOT NULL
        AND NOT (q.overturned_at IS NOT NULL AND q.replacement IS NULL)),
       candidates AS (SELECT *,COUNT(*) OVER () candidate_count FROM raw_candidates)
       SELECT question_id,question_record_id,run_record_id,workflow_cursor_record_id,question,answer,answer_basis,
        answered_at,answerer_kind,answered_by_name,overturned_at,overturned_by_name,replacement,candidate_count
       FROM candidates ORDER BY effective_at DESC,question_id DESC LIMIT $3`,
      [input.projectId, input.taskId, limit],
    )) as Row[]
  return (await tx.unsafe(
    `SELECT COALESCE(run_project.name,stage_project.name,direct_project.name) project
     FROM question q LEFT JOIN run owner ON owner.id=q.run_id LEFT JOIN project run_project ON run_project.id=owner.project_id
     LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
     LEFT JOIN project stage_project ON stage_project.id=stage.project_id
     LEFT JOIN project direct_project ON direct_project.id=q.project_id LIMIT $1`,
    [limit],
  )) as Row[]
}

export async function readRecordQuestions(
  input: Tenant & QuestionReadInput,
): Promise<{ items: Row[] }> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return { items: await rows(tx, input) }
  })
}
