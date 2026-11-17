// concern: hosted-question-read
/** Reads question-owned facts in the same row shapes as the local question reads. */
import type { SQL } from 'bun'
import {
  encodeRecordChangeCursor,
  MAX_RECORD_CHANGE_PAGE_SIZE,
  type RecordChangeReadPage,
  readRecordChanges,
} from '../../../shared/record/record-changes.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import {
  type QuestionReadInput,
  type RecordQuestionReadInput,
  UnboundedQuestionRulingsError,
} from './record-question-contract.ts'
import {
  RECORD_QUESTION_INBOX_STEP_COLUMNS,
  RECORD_QUESTION_STEP_COLUMNS,
} from './record-question-step.ts'

type Tenant = { url: string } & TenantPrincipal
type Row = Record<string, unknown>
export const RECORD_QUESTION_CHANGE_TABLES = ['question'] as const
const limited = (rows: Row[], limit?: number): Row[] =>
  limit === undefined ? rows : rows.slice(0, limit)

type RulingRead = Extract<RecordQuestionReadInput, { read: 'rulings' }>

async function recordQuestionRulingRows(
  tx: SQL,
  input: Pick<RulingRead, 'kind' | 'since'> & {
    ids?: readonly string[]
    afterNumber?: number
    limit?: number
  },
): Promise<Row[]> {
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
  if (input.ids) {
    if (!input.ids.length) return []
    const first = values.length
    values.push(...input.ids)
    clauses.push(
      `q.id IN (${input.ids.map((_, index) => `$${first + index + 1}::uuid`).join(',')})`,
    )
  }
  if (input.afterNumber !== undefined) {
    values.push(input.afterNumber)
    clauses.push(`q.number>$${values.length}`)
  }
  const sqlLimit = input.limit === undefined ? '' : ` LIMIT ${input.limit}`
  return (await tx.unsafe(
    `SELECT q.number,q.id::text record_id,q.run_id::text run_record_id,owner.number run_number,
      q.workflow_cursor_record_id::text workflow_cursor_id,q.workflow_key,q.workflow_task_id::text workflow_task_record_id,
      COALESCE(run_project.name,stage_project.name) project,stage.workflow workflow_slug,stage.mode mode_slug,
      COALESCE(owner.session_id,stage.session_id) session_id,q.asked_at::text,q.question,q.answer,q.answer_basis,
      q.answered_at::text,q.answered_by,q.answered_by_name,q.asked_via,q.answerer_kind,q.answer_channel,
      q.kind,q.jev_model,q.jev_pick,q.jev_probabilities::text,q.jev_agreed,q.jev_question_version,
      q.jev_fits,q.jev_order_flipped,
      q.closed_at::text,q.close_reason,q.overturned_at::text,q.overturned_by,q.overturned_by_name,
      q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text
     FROM question q LEFT JOIN run owner ON owner.id=q.run_id
     LEFT JOIN project run_project ON run_project.id=owner.project_id
     LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
     LEFT JOIN project stage_project ON stage_project.id=stage.project_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY q.number${sqlLimit}`,
    values,
  )) as Row[]
}

const QUESTION_DETAIL_COLUMNS = `q.id::text record_id,q.space_id::text space_id,q.number,q.run_id::text run_record_id,
  q.workflow_key,q.workflow_task_id::text workflow_task_record_id,
  q.workflow_cursor_record_id::text,q.project_id::text project_record_id,q.machine_id::text machine_id,q.revision,
  q.asked_at::text,q.question,q.options::text,q.recommendation,q.why,q.asked_via,q.kind,
  q.typed_options::text,q.criteria::text,q.levels::text,q.answer,q.answer_value,q.answer_basis,
  q.answered_at::text,q.answered_by,q.answered_by_name,q.answered_by_kind,q.answerer_kind,q.answer_channel,
  q.jev_pick,q.jev_confidence,q.jev_probabilities::text,q.jev_model,q.jev_input_tokens,q.jev_error,
  q.jev_agreed,q.jev_question_version,q.jev_fits,q.jev_order_flipped,q.awaiting_operator_at::text,
  q.relayed_by,q.overturned_at::text,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement,
  q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text,q.closed_at::text,q.close_reason,
  q.withheld_fields,q.created_at::text,q.updated_at::text,
  owner.number run_number,owner.id::text owner_id,owner.status owner_status,NULL::integer owner_pid,
  COALESCE(owner.parent_run_id,owner.id)::text root_id,
  stage.number workflow_cursor_number,stage.workflow workflow_slug,stage.mode mode_slug,
  ${RECORD_QUESTION_STEP_COLUMNS},
  stage.session_id workflow_owner,stage.updated_at::text workflow_updated_at,stage.state cursor_state,
  stage.arguments::text args,COALESCE(run_project.name,stage_project.name) repo,
  NULL::text cwd,COALESCE(run_project.name,stage_project.name) project_name,
  NULL::text project_path,COALESCE(owner.task_key,q.workflow_key) launch_key,
  COALESCE(owner.task_key,q.workflow_key) "taskHolder",
  (SELECT latest.status FROM run latest
    WHERE latest.id=COALESCE(owner.parent_run_id,owner.id)
       OR latest.parent_run_id=COALESCE(owner.parent_run_id,owner.id)
    ORDER BY latest.turn DESC,latest.number DESC LIMIT 1) latest_status,
  COALESCE(owner.project_id,stage.project_id)::text project_record_id`

type QuestionDetailInput = {
  ids?: readonly string[]
  runId?: string
  runIds?: readonly string[]
  workflowCursorRecordId?: string
  sessionId?: string
  taskRecordIds?: readonly string[]
}

function questionDetailFilter(input: QuestionDetailInput): {
  predicate: string
  values: string[]
} | null {
  if (input.ids) {
    if (!input.ids.length) return null
    return {
      predicate: `q.id IN (${input.ids.map((_, index) => `$${index + 1}::uuid`).join(',')})`,
      values: [...input.ids],
    }
  }
  if (input.runIds) {
    if (!input.runIds.length) return null
    return {
      predicate: `q.run_id IN (${input.runIds.map((_, index) => `$${index + 1}::uuid`).join(',')})`,
      values: [...input.runIds],
    }
  }
  if (input.runId) return { predicate: 'q.run_id=$1::uuid', values: [input.runId] }
  if (input.workflowCursorRecordId)
    return {
      predicate: 'q.workflow_cursor_record_id=$1::uuid',
      values: [input.workflowCursorRecordId],
    }
  if (input.sessionId)
    return {
      predicate: 'COALESCE(owner.session_id,stage.session_id)=$1',
      values: [input.sessionId],
    }
  if (!input.taskRecordIds?.length) return null
  return {
    predicate: `q.workflow_task_id IN (${input.taskRecordIds.map((_, index) => `$${index + 1}::uuid`).join(',')}) AND q.answered_at IS NULL AND q.closed_at IS NULL`,
    values: [...input.taskRecordIds],
  }
}

async function recordQuestionDetails(tx: SQL, input: QuestionDetailInput): Promise<Row[]> {
  const filter = questionDetailFilter(input)
  if (!filter) return []
  return (await tx.unsafe(
    `SELECT ${QUESTION_DETAIL_COLUMNS} FROM question q
     LEFT JOIN run owner ON owner.id=q.run_id
     LEFT JOIN project run_project ON run_project.id=owner.project_id
     LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
     LEFT JOIN project stage_project ON stage_project.id=stage.project_id
     WHERE ${filter.predicate} ORDER BY q.number`,
    filter.values,
  )) as Row[]
}

async function boundedIdentityRows(tx: SQL, input: QuestionReadInput): Promise<Row[] | null> {
  if (input.read === 'max-number')
    return (await tx.unsafe('SELECT COALESCE(MAX(number),0) number FROM question', [])) as Row[]
  if (input.read === 'by-number')
    return limited(
      (await tx.unsafe(
        `SELECT ${QUESTION_DETAIL_COLUMNS} FROM question q
         LEFT JOIN run owner ON owner.id=q.run_id
         LEFT JOIN project run_project ON run_project.id=owner.project_id
         LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
         LEFT JOIN project stage_project ON stage_project.id=stage.project_id
         WHERE q.number=$1`,
        [input.number],
      )) as Row[],
      input.limit,
    )
  if (input.read !== 'open-for-cursors') return null
  return limited(
    (await tx.unsafe(
      `SELECT workflow_cursor_record_id::text,space_id::text space_id,MIN(number) number FROM question
       WHERE workflow_cursor_record_id IN (${input.workflowCursorRecordIds.map((_, index) => `$${index + 1}::uuid`).join(',')})
         AND answered_at IS NULL AND closed_at IS NULL
       GROUP BY workflow_cursor_record_id,space_id ORDER BY number`,
      input.workflowCursorRecordIds,
    )) as Row[],
    input.limit,
  )
}

async function targetedRows(tx: SQL, input: QuestionReadInput): Promise<Row[] | null> {
  if (input.read === 'by-id') return limited(await recordQuestionDetails(tx, input), input.limit)
  if (input.read === 'for-run')
    return limited(await recordQuestionDetails(tx, { runId: input.runId }), input.limit)
  if (input.read === 'for-runs')
    return limited(await recordQuestionDetails(tx, { runIds: input.runIds }), input.limit)
  if (input.read === 'for-session')
    return limited(await recordQuestionDetails(tx, { sessionId: input.sessionId }), input.limit)
  const identityRows = await boundedIdentityRows(tx, input)
  if (identityRows !== null) return identityRows
  if (input.read === 'for-cursor')
    return limited(
      await recordQuestionDetails(tx, { workflowCursorRecordId: input.workflowCursorRecordId }),
      input.limit,
    )
  if (input.read === 'open-for-tasks')
    return limited(
      await recordQuestionDetails(tx, { taskRecordIds: input.taskRecordIds }),
      input.limit,
    )
  if (input.read === 'unlinked-workflow') return unlinkedWorkflowRows(tx, input)
  if (input.read === 'rule-audit-reasons')
    return limited(
      (await tx.unsafe(
        `SELECT audit.reason FROM question_mutation_audit audit
         JOIN question q ON q.id=audit.question_id
         WHERE q.workflow_cursor_record_id=$1::uuid AND audit.action='rule' AND audit.actor_session=$2
         ORDER BY audit.at,audit.id`,
        [input.workflowCursorRecordId, input.actorSession],
      )) as Row[],
      input.limit,
    )
  return null
}

async function unlinkedWorkflowRows(
  tx: SQL,
  input: Extract<QuestionReadInput, { read: 'unlinked-workflow' }>,
): Promise<Row[]> {
  const clauses = [
    'q.workflow_cursor_record_id IS NOT NULL',
    'q.workflow_key IS NOT NULL',
    'q.workflow_task_id IS NULL',
  ]
  const values: string[] = []
  if (input.project) {
    values.push(input.project)
    clauses.push(`stage_project.name=$${values.length}`)
  }
  if (input.workflowKey) {
    values.push(input.workflowKey)
    clauses.push(`q.workflow_key=$${values.length}`)
  }
  return limited(
    (await tx.unsafe(
      `SELECT ${QUESTION_DETAIL_COLUMNS} FROM question q
       LEFT JOIN run owner ON owner.id=q.run_id
       LEFT JOIN project run_project ON run_project.id=owner.project_id
       LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
       LEFT JOIN project stage_project ON stage_project.id=stage.project_id
       WHERE ${clauses.join(' AND ')} ORDER BY q.number`,
      values,
    )) as Row[],
    input.limit,
  )
}

function offsetClause(limit: number | undefined, offset: number): string {
  if (limit !== undefined) return ` LIMIT ${limit} OFFSET ${offset}`
  return offset === 0 ? '' : ` OFFSET ${offset}`
}

async function inboxRows(
  tx: SQL,
  input: Extract<QuestionReadInput, { read: 'inbox' }>,
): Promise<Row[]> {
  const offset = input.changedAfter === undefined ? 0 : Number(input.changedAfter)
  const requested = input.limit === undefined ? undefined : input.limit + 1
  const runCount = Number(
    (
      (await tx.unsafe(
        `SELECT COUNT(*) count FROM question q
         WHERE q.run_id IS NOT NULL AND q.answered_at IS NULL AND q.closed_at IS NULL`,
        [],
      )) as Array<{ count: number | string }>
    )[0]?.count ?? 0,
  )
  const runs = (await tx.unsafe(
    `SELECT q.number,q.id::text record_id,q.run_id::text run_record_id,owner.number run_number,
      q.asked_at::text,q.question,q.options::text,q.recommendation,q.why,q.kind,q.jev_pick,q.jev_confidence,
      q.jev_probabilities::text,q.jev_error,q.answered_at::text,q.overturned_at::text,q.overturned_by,
      q.overturn_reason,q.replacement,q.filed_as,q.filed_ref,q.filed_record_id::text,q.filed_label,q.filed_at::text,
      owner.agent,owner.job,root_project.name repo,COALESCE(owner.task_key,root.task_key) task_key,root.project_id::text project_record_id,owner.status,owner.session_id,
      q.awaiting_operator_at::text,
      root.status root_status,root.id::text root_record_id,root.number root_number,
      CASE WHEN root.evidence_excluded IS NULL THEN 0 ELSE 1 END root_voided,
      COALESCE(owner.parent_run_id,owner.id)::text root_id
     FROM question q JOIN run owner ON owner.id=q.run_id
     JOIN run root ON root.id=COALESCE(owner.parent_run_id,owner.id)
     LEFT JOIN project root_project ON root_project.id=root.project_id
     WHERE q.answered_at IS NULL AND q.closed_at IS NULL
     ORDER BY q.run_id,q.number${offsetClause(requested, offset)}`,
    [],
  )) as Row[]
  const workflowOffset = Math.max(0, offset - runCount)
  const workflowLimit = requested === undefined ? undefined : Math.max(0, requested - runs.length)
  const workflows = (await tx.unsafe(
    `SELECT q.number,q.id::text record_id,q.asked_at::text,q.question,stage.number cursor_record_id,
      project.name project,stage.project_id::text project_record_id,stage.workflow workflow_slug,
      stage.mode mode_slug,stage.arguments::text args,
      ${RECORD_QUESTION_INBOX_STEP_COLUMNS},stage.session_id
     FROM question q JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
     JOIN project ON project.id=stage.project_id
     WHERE stage.state='awaiting-ruling' AND q.answered_at IS NULL AND q.closed_at IS NULL
     ORDER BY q.asked_at,q.number${offsetClause(workflowLimit, workflowOffset)}`,
    [],
  )) as Row[]
  const combined = [...runs, ...workflows]
  return input.limit === undefined ? combined : combined.slice(0, input.limit + 1)
}

async function rows(tx: SQL, input: QuestionReadInput): Promise<Row[]> {
  const targeted = await targetedRows(tx, input)
  if (targeted !== null) return targeted
  if (input.read === 'inbox') return inboxRows(tx, input)
  if (input.read === 'waiting')
    return limited(
      (await tx.unsafe(
        `SELECT stage.number id,stage.id::text workflow_cursor_record_id,project.name project,
        q.id::text question_record_id,q.workflow_key task_key,q.question,q.asked_at::text waiting_since,
        stage.workflow workflow_slug,stage.mode mode_slug,stage.arguments::text args,stage.session_id
       FROM task_flow_stage stage JOIN question q ON q.workflow_cursor_record_id=stage.id
       JOIN project ON project.id=stage.project_id
       WHERE stage.state='awaiting-ruling' AND q.answered_at IS NULL AND q.closed_at IS NULL
       ORDER BY q.asked_at,q.number`,
        [],
      )) as Row[],
      input.limit,
    )
  if (input.read === 'open-for-session')
    return limited(
      (await tx.unsafe(
        `SELECT stage.id::text record_id,stage.number,project.name project,stage.workflow workflow_slug,
        stage.mode mode_slug,stage.workflow_key,stage.state,stage.updated_at::text updated_at,
        (SELECT q.id::text FROM question q WHERE q.workflow_cursor_record_id=stage.id
          AND q.answered_at IS NULL AND q.closed_at IS NULL LIMIT 1) open_question_record_id
       FROM task_flow_stage stage JOIN project ON project.id=stage.project_id
       WHERE stage.session_id=$1 AND stage.state NOT IN ('done','abandoned')
       ORDER BY stage.number`,
        [input.sessionId],
      )) as Row[],
      input.limit,
    )
  if (input.read === 'rulings') {
    return limited(await recordQuestionRulingRows(tx, input), input.limit)
  }
  if (input.read === 'task-rulings')
    return limited(
      (await tx.unsafe(
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
       FROM candidates ORDER BY effective_at DESC,question_id DESC`,
        [input.projectId, input.taskId],
      )) as Row[],
      input.limit,
    )
  return limited(
    (await tx.unsafe(
      `SELECT COALESCE(run_project.name,stage_project.name,direct_project.name) project
     FROM question q LEFT JOIN run owner ON owner.id=q.run_id LEFT JOIN project run_project ON run_project.id=owner.project_id
     LEFT JOIN task_flow_stage stage ON stage.id=q.workflow_cursor_record_id
     LEFT JOIN project stage_project ON stage_project.id=stage.project_id
     LEFT JOIN project direct_project ON direct_project.id=q.project_id`,
      [],
    )) as Row[],
    input.limit,
  )
}

export async function readRecordQuestionRows(
  tx: SQL,
  input: Exclude<QuestionReadInput, { read: 'rulings' }>,
): Promise<{ items: Row[]; cursor?: string; more?: boolean }> {
  const items = await rows(tx, input)
  if (input.read !== 'inbox' || input.limit === undefined) return { items }
  const offset = input.changedAfter === undefined ? 0 : Number(input.changedAfter)
  const page = items.slice(0, input.limit)
  return { items: page, cursor: String(offset + page.length), more: items.length > input.limit }
}

type RulingsInput = Tenant & Extract<RecordQuestionReadInput, { read: 'rulings' }>
type RecordPool = ReturnType<typeof recordPool>

async function readRulingPage(client: RecordPool, input: RulingsInput) {
  const pageSize = input.limit ?? 100
  return client.begin(async (tx) => {
    await bindTenant(tx, input)
    const all = await recordQuestionRulingRows(tx, {
      kind: input.kind,
      since: input.since,
      afterNumber:
        input.changedAfter && 'questionNumber' in input.changedAfter
          ? input.changedAfter.questionNumber
          : undefined,
      limit: pageSize + 1,
    })
    const items = all.slice(0, pageSize)
    const last = items.at(-1)
    return {
      items,
      ...(last ? { cursor: `page:${String(last.number)}` } : {}),
      more: all.length > pageSize,
    }
  })
}

async function readRulingChanges(client: RecordPool, input: RulingsInput) {
  const materialize = async (tx: SQL, page: RecordChangeReadPage) => {
    const items = page.resetRequired
      ? limited(await recordQuestionRulingRows(tx, input), input.limit)
      : await recordQuestionRulingRows(tx, {
          kind: input.kind,
          since: input.since,
          ids: [...new Set(page.changes.map(({ id }) => id))],
        })
    return {
      items,
      cursor: encodeRecordChangeCursor(page.cursor),
      more: page.resetRequired ? false : page.more,
      reset: page.resetRequired,
    }
  }
  if (input.changedAfter !== undefined) {
    if ('questionNumber' in input.changedAfter)
      throw new Error('page cursors must use the rulings page read')
    return readRecordChanges(
      client,
      input,
      input.changedAfter,
      MAX_RECORD_CHANGE_PAGE_SIZE,
      RECORD_QUESTION_CHANGE_TABLES,
      materialize,
    )
  }

  let after = (
    await readRecordChanges(
      client,
      input,
      null,
      MAX_RECORD_CHANGE_PAGE_SIZE,
      RECORD_QUESTION_CHANGE_TABLES,
    )
  ).cursor
  while (true) {
    const page = await readRecordChanges(
      client,
      input,
      after,
      MAX_RECORD_CHANGE_PAGE_SIZE,
      RECORD_QUESTION_CHANGE_TABLES,
      async (tx, current) => {
        if (current.resetRequired || current.more)
          return { done: false as const, cursor: current.cursor }
        const allItems = await recordQuestionRulingRows(tx, input)
        const items = limited(allItems, input.limit)
        if (items.length < allItems.length) return { done: true as const, result: { items } }
        return {
          done: true as const,
          result: {
            items,
            cursor: encodeRecordChangeCursor(current.cursor),
            more: false,
            reset: false,
          },
        }
      },
    )
    if (page.done) return page.result
    after = page.cursor
  }
}

export async function readRecordQuestions(
  input: Tenant & RecordQuestionReadInput,
): Promise<{ items: Row[]; cursor?: string; more?: boolean; reset?: boolean }> {
  if (input.read === 'rulings') {
    if (input.since === undefined && input.limit === undefined && input.changedAfter === undefined)
      throw new UnboundedQuestionRulingsError()
    const client = recordPool(input.url)
    if (input.limit !== undefined || (input.changedAfter && 'questionNumber' in input.changedAfter))
      return readRulingPage(client, input)
    return readRulingChanges(client, input)
  }
  const client = recordPool(input.url)
  return client.begin(async (tx) => {
    await bindTenant(tx, input)
    return readRecordQuestionRows(tx, input)
  })
}
