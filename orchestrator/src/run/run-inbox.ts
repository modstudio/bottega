// concern: run-inbox
/** Knows asking-run and ruling inbox. Must not know run control, transports, routing, the CLI, or worktrees. */
import { db, SESSION_LIVE_MS, sessionId } from '../database/db.ts'
import { activeSql, voidedSql } from '../evidence/evidence-query.ts'
import { projectAt } from '../project/projects.ts'
import { resolveProjectAutonomy } from '../workflow/autonomy.ts'

type RunInboxFlags = { has(name: string): boolean }
type RunInboxPresentation = {
  log(...values: unknown[]): void
  dur(ms: number | null | undefined): string
  chainHasPendingDelivery(rootId: number): boolean
  strandedRecovery(rootId: number): string
}

export async function runInboxCommand(
  flags: RunInboxFlags,
  presentation: RunInboxPresentation,
): Promise<void> {
  const { has } = flags
  const { log, dur, chainHasPendingDelivery, strandedRecovery } = presentation
  const sid = sessionId()
  const mine = !has('all')
  const activeOnly = has('active')
  const project = mine ? projectAt(process.cwd()) : null
  const rulings = project ? (await resolveProjectAutonomy(project.name)).rulings : null
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
  const allRows = db()
    .query(
      `SELECT q.id, q.run_id, q.asked_at, q.question, q.options, q.recommendation, q.why,
            r.agent, r.job, r.repo, r.status, r.session_id,
            root.status root_status,
            ${activeSql('root')} root_active,
            ${voidedSql('root')} root_voided,
            COALESCE(r.parent_run_id, r.id) root_id,
            ${sessionRecent} session_recent
       FROM question q JOIN run r ON r.id = q.run_id
       JOIN run root ON root.id = COALESCE(r.parent_run_id, r.id)
       ${seenJoin}
      WHERE ${
        mine || activeOnly
          ? `q.answered_at IS NULL AND ${activeSql('root')}`
          : `q.answered_at IS NULL OR NOT (${activeSql('root')})`
      }
      ORDER BY q.run_id, q.id`,
    )
    .all(...(hasSessionSeen ? [cutoff] : [])) as {
    id: number
    run_id: number
    asked_at: string
    question: string
    options: string | null
    recommendation: string | null
    why: string | null
    agent: string
    job: string
    repo: string | null
    status: string
    session_id: string | null
    root_status: string
    root_active: number
    root_voided: number
    root_id: number
    session_recent: number
  }[]
  // Inside a registered project, the default view is the union of questions in
  // that project and questions owned by this session. Visibility does not make
  // a question owned by another session answerable.
  const rows = mine
    ? project
      ? allRows.filter((q) => q.repo === project.name || (sid !== null && q.session_id === sid))
      : allRows.filter((q) => sid !== null && q.session_id === sid)
    : allRows
  const canAnswer = (owner: string | null) => owner === null || (sid !== null && owner === sid)
  const active = rows.filter((q) => q.root_active)
  const terminal = rows.filter((q) => !active.includes(q))
  const answerable = active.filter((q) => canAnswer(q.session_id))
  const visible = active.filter((q) => !canAnswer(q.session_id))

  if (has('json')) {
    log(
      JSON.stringify(
        rows.map((q) => ({
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
          can_answer: Boolean(q.root_active) && canAnswer(q.session_id),
          question: q.question,
          options: q.options ? (JSON.parse(q.options) as string[]) : [],
          recommendation: q.recommendation,
          why: q.why,
          status: q.root_voided ? 'voided' : q.root_status,
        })),
      ),
    )
    return
  }

  if (rulings) log(`rulings=${rulings.value} (${rulings.scope})`)

  const recoverable = db()
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
        ${mine ? (project ? 'AND (root.repo = ? OR root.session_id = ?)' : 'AND root.session_id = ?') : ''}
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
    .all(...(mine ? (project ? [project.name, sid] : [sid]) : [])) as {
    id: number
    agent: string
    job: string
    repo: string | null
    session_id: string | null
  }[]

  if (!rows.length && !recoverable.length) {
    log(
      mine && project
        ? `no open questions for ${project.name}`
        : mine
          ? 'no questions waiting on you'
          : 'no open questions',
    )
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
  }
  return
}
