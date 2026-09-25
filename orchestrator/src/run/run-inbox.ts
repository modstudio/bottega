// concern: run-inbox
/** Knows asking-run and ruling inbox. Must not know run control, transports, routing, the CLI, or worktrees. */
import { db, SESSION_LIVE_MS, sessionId } from '../database/db.ts'
import { voidedSql } from '../evidence/evidence-query.ts'
import { projectAt } from '../project/projects.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy-scopes.ts'
import { rulingStatus } from './question-vocabulary.ts'
import { answerRunLivenessRefusal } from './run-answer-liveness.ts'

type RunInboxFlags = { has(name: string): boolean }
type RunInboxPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
  chainHasPendingDelivery(rootId: number): boolean
  strandedRecovery(rootId: number): string
}

export function rowsForInboxProject<T extends { repo: string | null }>(
  rows: T[],
  project: string | null,
): T[] {
  return project === null ? [] : rows.filter((row) => row.repo === project)
}

function rowsForInboxView<T extends { repo: string | null; session_id: string | null }>(
  rows: T[],
  scopedProject: string | null | undefined,
  defaultProject: string | null,
  mine: boolean,
  sid: string | null,
): T[] {
  if (scopedProject !== undefined) return rowsForInboxProject(rows, scopedProject)
  if (!mine) return rows
  if (defaultProject)
    return rows.filter(
      (row) => row.repo === defaultProject || (sid !== null && row.session_id === sid),
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

export async function runInboxCommand(
  flags: RunInboxFlags,
  presentation: RunInboxPresentation,
  requestedCwd?: string,
): Promise<void> {
  const { has } = flags
  const { log, dur, chainHasPendingDelivery, strandedRecovery } = presentation
  const sid = sessionId()
  const mine = !has('all')
  const activeOnly = has('active')
  const scoped = requestedCwd !== undefined
  const scopedProject = scoped ? projectAt(requestedCwd) : null
  const project = scoped ? scopedProject : mine ? projectAt(process.cwd()) : null
  const scopedProjectName = scoped ? (scopedProject?.name ?? null) : undefined
  const header = await rulingsHeader(project)
  const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
  const hasSessionSeen = Boolean(
    db().query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`).get(),
  )
  const seenJoin = hasSessionSeen
    ? 'LEFT JOIN session_seen seen ON seen.session_id = r.session_id'
    : ''
  const sessionRecent = hasSessionSeen
    ? 'CASE WHEN r.session_id IS NOT NULL AND seen.last_seen >= ? THEN 1 ELSE 0 END'
    : '0'
  const queriedRows = db()
    .query(
      `SELECT q.id, q.run_id, q.asked_at, q.question, q.options, q.recommendation, q.why,
            q.answered_at,
            q.answer, q.overturned_at, q.overturned_by, q.overturn_reason, q.replacement,
            r.agent, r.job, r.repo, r.status, r.session_id,
            root.status root_status,
            ${voidedSql('root')} root_voided,
            COALESCE(r.parent_run_id, r.id) root_id,
            ${sessionRecent} session_recent
       FROM question q JOIN run r ON r.id = q.run_id
       JOIN run root ON root.id = COALESCE(r.parent_run_id, r.id)
       ${seenJoin}
      ORDER BY q.run_id, q.id`,
    )
    .all(...(hasSessionSeen ? [cutoff] : [])) as {
    id: number
    run_id: number
    asked_at: string
    question: string
    answered_at: string | null
    answer: string | null
    overturned_at: string | null
    overturned_by: string | null
    overturn_reason: string | null
    replacement: string | null
    options: string | null
    recommendation: string | null
    why: string | null
    agent: string
    job: string
    repo: string | null
    status: string
    session_id: string | null
    root_status: string
    root_voided: number
    root_id: number
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
  const rows = rowsForInboxView(allRows, scopedProjectName, project?.name ?? null, mine, sid)
  const canAnswer = (owner: string | null) => owner === null || (sid !== null && owner === sid)
  const active = rows.filter(isLive)
  const terminal = rows.filter((q) => !active.includes(q))
  const answerable = active.filter((q) => canAnswer(q.session_id))
  const visible = active.filter((q) => !canAnswer(q.session_id))

  if (has('json')) {
    const presentedRows = rows.map((q) => ({
      question_id: q.id,
      run_id: q.run_id,
      answer_id: q.root_id,
      job: q.job,
      agent: q.agent,
      repo: q.repo,
      asked_at: q.asked_at,
      // Kept as a nullable compatibility field: false used to assert death,
      // which a last-seen timestamp cannot establish.
      session_live: q.session_recent ? true : null,
      session_liveness: q.session_recent ? 'live' : 'unknown',
      can_answer: isLive(q) && canAnswer(q.session_id),
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
    }))
    log(inboxJson(presentedRows, scopedProjectName))
    return
  }

  presentHeader(header).forEach((line) => {
    log(line)
  })

  const queriedRecoverable = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.repo, root.session_id
       FROM run root
      WHERE root.parent_run_id IS NULL
        AND (root.status = 'asking' OR EXISTS (
          SELECT 1 FROM question pending JOIN run owner ON owner.id=pending.run_id
           WHERE (owner.id=root.id OR owner.parent_run_id=root.id)
             AND pending.answered_at IS NOT NULL
             AND pending.delivery_pending_at IS NOT NULL
        ))
        ${!scoped && mine ? (project ? 'AND (root.repo = ? OR root.session_id = ?)' : 'AND root.session_id = ?') : ''}
        AND NOT EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
           WHERE (owner.id = root.id OR owner.parent_run_id = root.id)
             AND q.answered_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM run active
           WHERE active.parent_run_id = root.id AND active.status = 'running'
        )
      ORDER BY root.id`,
    )
    .all(...(!scoped && mine ? (project ? [project.name, sid] : [sid]) : [])) as {
    id: number
    agent: string
    job: string
    repo: string | null
    session_id: string | null
  }[]
  const recoverable = rowsForInboxView(queriedRecoverable, scopedProjectName, null, false, sid)

  if (!rows.length && !recoverable.length) {
    log(emptyInboxMessage(project, mine))
    return
  }
  let lastRun = -1
  let lastRoot = -1
  for (const q of answerable) {
    if (q.run_id !== lastRun) {
      log(`\nrun ${q.run_id} · ${q.agent}/${q.job}${q.repo ? ` · ${q.repo}` : ''} · ${q.status}`)
      lastRun = q.run_id
    }
    lastRoot = q.root_id
    log(`  [q${q.id}] ${q.question}`)
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
      `\nrule on them:  orch answer ${lastRoot} "<ruling>"    (one per question, in order)` +
        `\n               orch answer ${lastRoot} --q<id> "<ruling>"`,
    )
  }
  for (const r of recoverable) {
    const stranded = chainHasPendingDelivery(r.id)
    if (canAnswer(r.session_id)) {
      log(
        `\nrun ${r.id} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          (stranded
            ? `asking, but no ruling is open — ${strandedRecovery(r.id)}`
            : `asking, but no ruling is open — recoverable: orch continue ${r.id}`),
      )
      if (r.session_id === null) {
        log('        unowned — any session may continue it')
      }
    } else {
      log(
        `\nrun ${r.id} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          `asking, but no ruling is open · owner ${r.session_id} · visible only; ` +
          (stranded
            ? `stranded — only the owning session may use orch retry ${r.id} --agent … or orch abandon ${r.id}`
            : 'only the owning session may continue it'),
      )
    }
  }
  if (visible.length) {
    log('\nvisible here, but owned by another session:')
    for (const q of visible) {
      const liveness = q.session_recent ? 'live' : 'unknown'
      log(
        `\n  [q${q.id}] run ${q.run_id} · ${q.job} · ${q.agent}` +
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
    log(`  [q${q.id}] ${q.question}`)
    presentOverturn(q, log)
  }
  return
}
