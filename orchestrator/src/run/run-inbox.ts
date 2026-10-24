// concern: run-inbox
/** Knows asking-run and ruling inbox. Must not know run control, transports, routing, the CLI, or worktrees. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, SESSION_LIVE_MS, sessionId } from '../database/db.ts'
import { voidedSql } from '../evidence/evidence-query.ts'
import { projectAt } from '../project/projects.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import { questionOpenSql } from './question-open.ts'
import { rulingStatus } from './question-vocabulary.ts'
import { answerRunLivenessRefusal } from './run-answer-liveness.ts'

type RunInboxFlags = { has(name: string): boolean }
type RunInboxPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
  chainHasPendingDelivery(rootId: string): boolean
  strandedRecovery(rootId: string): string
}
type InboxQuestion = {
  question_id: number
  question_record_id: string
  run_record_id: string
  run_number: number
  answer_id: number
  answer_record_id: string
  job: string
  agent: string
  repo: string | null
  asked_at: string
  session_live: true | null
  session_liveness: 'live' | 'unknown'
  can_answer: boolean
  question: string
  options: string[]
  recommendation: string | null
  why: string | null
  status: string
  ruling_status: 'open' | 'answered' | 'overturned'
  overturned_at: string | null
  overturned_by: string | null
  overturn_reason: string | null
  replacement: string | null
  filed_as: 'doc' | 'canon-proposal' | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
  filed_at: string | null
}

type WorkflowInboxQuestion = {
  kind: 'workflow'
  question_id: number
  question_record_id: string
  workflow: string
  project: string
  mode: string
  step: { n: number; slug: string }
  asked_at: string
  session_id: string | null
  can_answer: boolean
  question: string
  answer_command: string | null
  ownership_notice: string | null
}

type QueriedInboxQuestion = {
  number: number
  record_id: string
  run_record_id: string
  run_number: number
  asked_at: string
  question: string
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturn_reason: string | null
  replacement: string | null
  filed_as: 'doc' | 'canon-proposal' | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
  filed_at: string | null
  options: string | null
  recommendation: string | null
  why: string | null
  agent: string
  job: string
  repo: string | null
  project_record_id: string | null
  status: string
  session_id: string | null
  root_status: string
  root_voided: number
  root_id: string
  root_number: number
  root_record_id: string
  session_recent: number
}

type RecoverableInboxRow = {
  record_id: string
  number: number
  agent: string
  job: string
  repo: string | null
  project_record_id: string | null
  session_id: string | null
}

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

function inboxSessionCanAnswer(
  ownerSessionId: string | null,
  callerSessionId: string | null,
): boolean {
  return ownerSessionId === null || (callerSessionId !== null && ownerSessionId === callerSessionId)
}

function workflowInboxQuestions(input: InboxQuery): WorkflowInboxQuestion[] {
  if (input.scope === 'session') return []
  const sid = sessionId()
  const scoped = input.requestedCwd !== undefined
  const scopedProject = scoped ? projectAt(input.requestedCwd!) : null
  const defaultProject = !scoped && !input.all ? projectAt(process.cwd()) : null
  const rows = db()
    .query(
      `SELECT q.number,q.record_id,q.asked_at,q.question,c.number cursor_record_id,c.project,c.project_record_id,c.workflow_slug,c.mode_slug,c.args,
              c.ordinal,c.step_slug,c.session_id
         FROM question q JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        WHERE c.state='awaiting-ruling' AND ${questionOpenSql('q')}
        ORDER BY q.asked_at,q.number`,
    )
    .all() as Array<{
    number: number
    record_id: string
    asked_at: string
    question: string
    cursor_record_id: number
    project: string
    project_record_id: string | null
    workflow_slug: string
    mode_slug: string
    args: string
    ordinal: number
    step_slug: string
    session_id: string | null
  }>
  const visible = rows.filter((row) => {
    if (scoped) return scopedProject !== null && row.project_record_id === scopedProject.recordId
    if (input.all) return true
    if (defaultProject)
      return row.project_record_id === defaultProject.recordId || row.session_id === sid
    return sid !== null && row.session_id === sid
  })
  return visible.map((row) => {
    const flags = Object.entries(JSON.parse(row.args) as Record<string, string>)
      .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
      .join('')
    const canAnswer = inboxSessionCanAnswer(row.session_id, sid)
    return {
      kind: 'workflow',
      question_id: row.number,
      question_record_id: row.record_id,
      workflow: row.workflow_slug,
      project: row.project,
      mode: row.mode_slug,
      step: { n: row.ordinal + 1, slug: row.step_slug },
      asked_at: row.asked_at,
      session_id: row.session_id,
      can_answer: canAnswer,
      question: row.question,
      answer_command: canAnswer
        ? `${PLATFORM_SLUG} workflow rule ${shellWord(row.workflow_slug)} --project ${shellWord(row.project)} ` +
          `--mode ${shellWord(row.mode_slug)}${workflowCursorReference(row.cursor_record_id).cli}${flags} --ruling "<ruling>"`
        : null,
      ownership_notice: canAnswer
        ? null
        : `owned by session ${row.session_id ?? 'unknown'}; only that session, or the operator relaying a decision, may answer it`,
    }
  })
}

export type InboxQuery = {
  scope: 'session' | 'cli-default'
  all?: boolean
  activeOnly?: boolean
  requestedCwd?: string
}

function scopedProjectFilter(
  scoped: boolean,
  project: ReturnType<typeof projectAt>,
): ReturnType<typeof projectAt> | undefined {
  return scoped ? project : undefined
}

export async function queryInbox(
  input: InboxQuery,
): Promise<{ questions: Array<InboxQuestion | WorkflowInboxQuestion> }> {
  const sid = sessionId()
  const mine = input.scope === 'session' || !input.all
  const scoped = input.scope === 'cli-default' && input.requestedCwd !== undefined
  const scopedProject = scoped ? projectAt(input.requestedCwd!) : null
  const scopedFilter = scopedProjectFilter(scoped, scopedProject)
  const defaultProject =
    input.scope === 'cli-default' && !scoped && mine ? projectAt(process.cwd()) : null
  const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
  const seenJoin = 'LEFT JOIN session_seen seen ON seen.session_id = r.session_id'
  const sessionRecent =
    'CASE WHEN r.session_id IS NOT NULL AND seen.last_seen >= ? THEN 1 ELSE 0 END'
  const queriedRows = db()
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
            q.asked_at, q.question, q.options, q.recommendation, q.why,
            q.answered_at, q.overturned_at, q.overturned_by, q.overturn_reason, q.replacement,
            q.filed_as, q.filed_ref, q.filed_record_id, q.filed_label, q.filed_at,
            r.agent, r.job, r.repo, root.project_record_id, r.status, r.session_id,
            root.status root_status, root.record_id root_record_id, root.number root_number,
            ${voidedSql('root')} root_voided,
            COALESCE(r.parent_run_record_id, r.record_id) root_id, ${sessionRecent} session_recent
       FROM question q JOIN run r ON r.record_id = q.run_record_id
       JOIN run root ON root.record_id = COALESCE(r.parent_run_record_id, r.record_id)
       ${seenJoin}
      WHERE q.closed_at IS NULL
      ORDER BY q.run_record_id,q.number`,
    )
    .all(cutoff) as QueriedInboxQuestion[]
  const isLive = (question: (typeof queriedRows)[number]) =>
    answerRunLivenessRefusal(
      { status: question.root_status, voided: Boolean(question.root_voided) },
      [{ owner_status: question.status }],
    ) === null
  const selected = queriedRows.filter((question) =>
    mine || input.activeOnly
      ? question.answered_at === null && isLive(question)
      : question.answered_at === null || !isLive(question),
  )
  const visible =
    input.scope === 'session'
      ? selected.filter(
          (question) => isLive(question) && inboxSessionCanAnswer(question.session_id, sid),
        )
      : rowsForInboxView(selected, scopedFilter, defaultProject, mine, sid)
  return {
    questions: [
      ...visible.map(
        (q): InboxQuestion => ({
          question_id: q.number,
          question_record_id: q.record_id,
          run_record_id: q.run_record_id,
          run_number: q.run_number,
          answer_id: q.root_number,
          answer_record_id: q.root_record_id,
          job: q.job,
          agent: q.agent,
          repo: q.repo,
          asked_at: q.asked_at,
          session_live: q.session_recent ? true : null,
          session_liveness: q.session_recent ? 'live' : 'unknown',
          can_answer: isLive(q) && inboxSessionCanAnswer(q.session_id, sid),
          question: q.question,
          options: q.options ? (JSON.parse(q.options) as string[]) : [],
          recommendation: q.recommendation,
          why: q.why,
          status: q.root_voided ? 'voided' : q.root_status,
          ruling_status: rulingStatus(q.overturned_at, q.answered_at),
          overturned_at: q.overturned_at,
          overturned_by: q.overturned_by,
          overturn_reason: q.overturn_reason,
          replacement: q.replacement,
          filed_as: q.filed_as,
          filed_ref: q.filed_ref,
          filed_record_id: q.filed_record_id,
          filed_label: q.filed_label,
          filed_at: q.filed_at,
        }),
      ),
      ...workflowInboxQuestions(input),
    ],
  }
}

export function rowsForInboxProject<T extends { project_record_id: string | null }>(
  rows: T[],
  projectRecordId: string | null,
): T[] {
  return projectRecordId === null
    ? []
    : rows.filter((row) => row.project_record_id === projectRecordId)
}

function rowsForInboxView<
  T extends { project_record_id: string | null; session_id: string | null },
>(
  rows: T[],
  scopedProject: ReturnType<typeof projectAt> | undefined,
  defaultProject: ReturnType<typeof projectAt>,
  mine: boolean,
  sid: string | null,
): T[] {
  if (scopedProject !== undefined) return rowsForInboxProject(rows, scopedProject?.recordId ?? null)
  if (!mine) return rows
  if (defaultProject)
    return rows.filter(
      (row) =>
        row.project_record_id === defaultProject.recordId ||
        (sid !== null && row.session_id === sid),
    )
  return rows.filter((row) => sid !== null && row.session_id === sid)
}

function inboxJson(rows: object[], scopedProject: string | null | undefined): string {
  if (scopedProject === undefined) return JSON.stringify(rows)
  return JSON.stringify({
    cwd_registered: scopedProject !== null,
    project: scopedProject,
    rows,
  })
}

function emptyInboxMessage(project: { name: string } | null, mine: boolean): string {
  if (project) return `no open questions for ${project.name}`
  return mine ? 'no questions waiting on you' : 'no open questions'
}

async function rulingsHeader(project: { name: string } | null): Promise<string | null> {
  if (!project) return null
  const rulings = (await resolveProjectAutonomy(project.name, undefined, undefined)).rulings
  return `project default: rulings=${rulings.value} (${rulings.scope})${
    rulings.value === 'agent'
      ? '; answer what the specification or canon settles; relay a design or product-direction question to the operator and answer it with --from-operator.'
      : ''
  }`
}

function presentHeader(header: string | null): string[] {
  return header ? [header] : []
}

function presentOverturn(
  question: {
    overturned_at: string | null
    overturn_reason: string | null
    replacement: string | null
  },
  log: (...values: unknown[]) => void,
): void {
  if (!question.overturned_at) return
  log(`        overturned: ${question.overturn_reason}`)
  if (question.replacement) log(`        replacement: ${question.replacement}`)
}

function presentFiled(
  question: {
    filed_as: string | null
    filed_ref: string | null
    filed_record_id: string | null
    filed_label: string | null
  },
  log: (...values: unknown[]) => void,
): void {
  const shown = question.filed_label ?? question.filed_ref
  if (!shown) return
  const identity = question.filed_record_id ? ` (${question.filed_record_id})` : ''
  log(`        filed: ${question.filed_as} ${shown}${identity}`)
}

function presentWorkflowQuestions(
  rows: WorkflowInboxQuestion[],
  log: (...values: unknown[]) => void,
): void {
  for (const q of rows) {
    log(
      `\nworkflow ${q.workflow} · ${q.project} · mode ${q.mode} · step ${q.step.n} ${q.step.slug}`,
    )
    log(`  [q${q.question_id}] ${q.question}`)
    if (q.answer_command) log(`        answer: ${q.answer_command}`)
    if (q.ownership_notice) log(`        ${q.ownership_notice}`)
  }
}

async function presentJsonInbox(
  flags: RunInboxFlags,
  presentation: RunInboxPresentation,
  requestedCwd?: string,
): Promise<boolean> {
  if (!flags.has('json')) return false
  const result = await queryInbox({
    scope: 'cli-default',
    all: flags.has('all'),
    activeOnly: flags.has('active'),
    requestedCwd,
  })
  const scopedProjectName =
    requestedCwd === undefined ? undefined : (projectAt(requestedCwd)?.name ?? null)
  presentation.log(inboxJson(result.questions, scopedProjectName))
  return true
}

export async function runInboxCommand(
  flags: RunInboxFlags,
  presentation: RunInboxPresentation,
  requestedCwd?: string,
): Promise<void> {
  if (await presentJsonInbox(flags, presentation, requestedCwd)) return
  const { has } = flags
  const { log, dur, chainHasPendingDelivery, strandedRecovery } = presentation
  const sid = sessionId()
  const mine = !has('all')
  const activeOnly = has('active')
  const scoped = requestedCwd !== undefined
  const scopedProject = scoped ? projectAt(requestedCwd) : null
  const scopedFilter = scopedProjectFilter(scoped, scopedProject)
  const project = scoped ? scopedProject : mine ? projectAt(process.cwd()) : null
  const header = await rulingsHeader(project)
  const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
  const seenJoin = 'LEFT JOIN session_seen seen ON seen.session_id = r.session_id'
  const sessionRecent =
    'CASE WHEN r.session_id IS NOT NULL AND seen.last_seen >= ? THEN 1 ELSE 0 END'
  const queriedRows = db()
    .query(
      `SELECT q.number,q.run_record_id,r.number AS run_number,q.asked_at,q.question,q.options,q.recommendation,q.why,
            q.answered_at,
            q.answer, q.overturned_at, q.overturned_by, q.overturn_reason, q.replacement,
            q.filed_as, q.filed_ref, q.filed_record_id, q.filed_label, q.filed_at,
            r.agent, r.job, r.repo, root.project_record_id, r.status, r.session_id,
            root.status root_status, root.number root_number,
            ${voidedSql('root')} root_voided,
            COALESCE(r.parent_run_record_id, r.record_id) root_id,
            ${sessionRecent} session_recent
       FROM question q JOIN run r ON r.record_id = q.run_record_id
       JOIN run root ON root.record_id = COALESCE(r.parent_run_record_id, r.record_id)
       ${seenJoin}
      WHERE q.closed_at IS NULL
      ORDER BY q.run_record_id,q.number`,
    )
    .all(cutoff) as {
    number: number
    run_record_id: string
    run_number: number
    asked_at: string
    question: string
    answered_at: string | null
    answer: string | null
    overturned_at: string | null
    overturned_by: string | null
    overturn_reason: string | null
    replacement: string | null
    filed_as: string | null
    filed_ref: string | null
    filed_record_id: string | null
    filed_label: string | null
    filed_at: string | null
    options: string | null
    recommendation: string | null
    why: string | null
    agent: string
    job: string
    repo: string | null
    project_record_id: string | null
    status: string
    session_id: string | null
    root_status: string
    root_voided: number
    root_id: string
    root_number: number
    session_recent: number
  }[]
  const isLive = (question: (typeof queriedRows)[number]) =>
    answerRunLivenessRefusal(
      {
        status: question.root_status,
        voided: Boolean(question.root_voided),
      },
      [{ owner_status: question.status }],
    ) === null
  const allRows = queriedRows.filter((question) =>
    mine || activeOnly
      ? question.answered_at === null && isLive(question)
      : question.answered_at === null || !isLive(question),
  )
  // Inside a registered project, the default view is the union of questions in
  // that project and questions owned by this session. Visibility does not make
  // a question owned by another session answerable.
  const rows = rowsForInboxView(allRows, scopedFilter, project, mine, sid)
  const workflowRows = workflowInboxQuestions({
    scope: 'cli-default',
    all: has('all'),
    activeOnly,
    requestedCwd,
  })
  const canAnswer = (owner: string | null) => inboxSessionCanAnswer(owner, sid)
  const active = rows.filter(isLive)
  const terminal = rows.filter((q) => !active.includes(q))
  const answerable = active.filter((q) => canAnswer(q.session_id))
  const visible = active.filter((q) => !canAnswer(q.session_id))

  presentHeader(header).forEach((line) => {
    log(line)
  })

  const queriedRecoverable = db()
    .query(
      `SELECT root.record_id, root.number, root.agent, root.job, root.repo, root.project_record_id, root.session_id
       FROM run root
      WHERE root.parent_run_record_id IS NULL
        AND (root.status = 'asking' OR EXISTS (
          SELECT 1 FROM question pending JOIN run owner ON owner.record_id=pending.run_record_id
           WHERE (owner.record_id=root.record_id OR owner.parent_run_record_id=root.record_id)
             AND pending.answered_at IS NOT NULL
             AND pending.delivery_pending_at IS NOT NULL
        ))
        ${!scoped && mine ? (project ? 'AND (root.project_record_id = ? OR root.session_id = ?)' : 'AND root.session_id = ?') : ''}
        AND NOT EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.record_id = q.run_record_id
           WHERE (owner.record_id = root.record_id OR owner.parent_run_record_id = root.record_id)
             AND ${questionOpenSql('q')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM run active
           WHERE active.parent_run_record_id = root.record_id AND active.status = 'running'
        )
      ORDER BY root.number`,
    )
    .all(
      ...(!scoped && mine ? (project ? [project.recordId, sid] : [sid]) : []),
    ) as RecoverableInboxRow[]
  const recoverable = rowsForInboxView(queriedRecoverable, scopedFilter, null, false, sid)

  if (!rows.length && !recoverable.length && !workflowRows.length) {
    log(emptyInboxMessage(project, mine))
    return
  }
  presentWorkflowQuestions(workflowRows, log)
  let lastRun = ''
  let lastRoot = ''
  for (const q of answerable) {
    if (q.run_record_id !== lastRun) {
      log(
        `\nrun ${q.run_number} · ${q.agent}/${q.job}${q.repo ? ` · ${q.repo}` : ''} · ${q.status}`,
      )
      lastRun = q.run_record_id
    }
    lastRoot = q.root_id
    log(`  [q${q.number}] ${q.question}`)
    if (q.why) log(`        why: ${q.why}`)
    const opts = q.options ? (JSON.parse(q.options) as string[]) : []
    for (const o of opts) log(`        - ${o}`)
    if (q.recommendation) log(`        it would: ${q.recommendation}`)
    if (q.session_id === null) {
      log('        unowned — any session may rule, and the answering identity is recorded')
    }
  }
  if (answerable.length) {
    log(
      `\nrule on them:  ${PLATFORM_SLUG} question answer ${lastRoot} "<ruling>"    (one per question, in order)` +
        `\n               ${PLATFORM_SLUG} question answer ${lastRoot} --q<id> "<ruling>"`,
    )
  }
  for (const r of recoverable) {
    const stranded = chainHasPendingDelivery(r.record_id)
    if (canAnswer(r.session_id)) {
      log(
        `\nrun ${r.number} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          (stranded
            ? `asking, but no ruling is open — ${strandedRecovery(r.record_id)}`
            : `asking, but no ruling is open — recoverable: ${PLATFORM_SLUG} run continue ${r.record_id}`),
      )
      if (r.session_id === null) {
        log('        unowned — any session may continue it')
      }
    } else {
      log(
        `\nrun ${r.number} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          `asking, but no ruling is open · owner ${r.session_id} · visible only; ` +
          (stranded
            ? `stranded — only the owning session may use ${PLATFORM_SLUG} run retry ${r.record_id} --agent … or ${PLATFORM_SLUG} run abandon ${r.record_id}`
            : 'only the owning session may continue it'),
      )
    }
  }
  if (visible.length) {
    log('\nvisible here, but owned by another session:')
    for (const q of visible) {
      const liveness = q.session_recent ? 'live' : 'unknown'
      log(
        `\n  [q${q.number}] run ${q.run_number} · ${q.job} · ${q.agent}` +
          `${q.repo ? ` · ${q.repo}` : ''} · owner ${q.session_id ?? 'unknown'} · ` +
          `liveness ${liveness} · waiting ${dur(Date.now() - Date.parse(q.asked_at))}`,
      )
      log(`        ${q.question}`)
      if (q.why) log(`        why: ${q.why}`)
      const opts = q.options ? (JSON.parse(q.options) as string[]) : []
      for (const o of opts) log(`        - ${o}`)
      if (q.recommendation) log(`        recommendation: ${q.recommendation}`)
      log('        only the owning session may rule; visibility does not transfer authority')
    }
  }
  for (const q of terminal) {
    const status = q.root_voided ? 'voided' : q.root_status
    log(
      `\nrun ${q.root_id} · ${q.agent}/${q.job}${q.repo ? ` · ${q.repo}` : ''} · ` +
        `${status} (terminal)`,
    )
    log(`  [q${q.number}] ${q.question}`)
    presentOverturn(q, log)
    presentFiled(q, log)
  }
  return
}
