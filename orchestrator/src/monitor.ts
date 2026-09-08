import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  db, liveRuns, nowIso, pidAlive, UNSCORED_WHERE, writableDb, type MonitorSeverity,
} from './db.ts'
import { fileIssue } from './mcp.ts'
import { gitLocks } from './git-locks.ts'
import { projectAt, projects } from './projects.ts'
import { projectLockState, targetGitEnvironment } from './worktree.ts'
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'
import { allInjectChecks, storedPackDrift } from './canon.ts'
import { idleLabel, idleMsSince, idleWarnMs } from './events.ts'

const HUB = new URL('../../bin/hub', import.meta.url).pathname

export type MonitorCondition = {
  kind: string
  subject: string
  since: string | null
  ageMs: number | null
  detail: string
  action: string
  issueKey?: string | null
  affectedProject?: string
  severity?: MonitorSeverity | null
}

export type MonitorResult = {
  id: number
  startedAt: string
  finishedAt: string
  trigger: 'invoked' | 'backstop'
  conditions: MonitorCondition[]
  errors: string[]
  canon: { findings: number; docs: number }
}

const age = (since: string | null, clock: number) => {
  if (!since) return null
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, clock - at) : null
}

function git(cwd: string, args: string[]): string | null {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

function durationMs(value: string): number | null {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const match = value.match(/^(\d+(?:\.\d+)?)([smhd])$/)
  return match ? Math.round(Number(match[1]) * units[match[2]]!) : null
}

function elapsedDetail(elapsedMs: number | null): string {
  if (elapsedMs == null) return 'elapsed time unknown'
  if (elapsedMs < 60_000) return `elapsed ${Math.round(elapsedMs / 1000)}s`
  if (elapsedMs < 3_600_000) return `elapsed ${Math.round(elapsedMs / 60_000)}m`
  return `elapsed ${(elapsedMs / 3_600_000).toFixed(1)}h`
}

/** Report live runs whose vendor stream has gone quiet. Nothing is killed. */
export function idleRunConditions(clock = Date.now()): MonitorCondition[] {
  const threshold = idleWarnMs()
  const running = db().query(
    `SELECT id, started_at, last_event_at, agent, job FROM run WHERE status='running'`,
  ).all() as {
    id: number; started_at: string; last_event_at: string | null; agent: string; job: string
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    const label = idleLabel(run.last_event_at, run.started_at, clock, threshold)
    if (!label) return []
    const ageMs = idleMsSince(run.last_event_at, run.started_at, clock)
    return [{
      kind: 'idle', subject: `run:${run.id}`, since: run.last_event_at ?? run.started_at, ageMs,
      detail: `run ${run.id} ${run.agent}/${run.job} ${label}`,
      action: 'reported; nothing was signalled',
    }]
  })
}

/** Report vendor processes that vanished while their run still claims to be running. */
export function deadRunningProcessConditions(clock = Date.now()): MonitorCondition[] {
  const running = db().query(
    `SELECT id, started_at, pid, agent_pid, output_bytes FROM run WHERE status='running'`,
  ).all() as {
    id: number; started_at: string; pid: number | null; agent_pid: number | null
    output_bytes: number | null
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    // PID reuse makes this deliberately conservative: a reused pid looks live
    // and is not reported. A vendor that has just exited during normal teardown
    // is still an observed condition, not a repair trigger; carry the worker's
    // liveness so the reader can distinguish that transient from a dead worker.
    if (!run.agent_pid || pidAlive(run.agent_pid)) return []
    const ageMs = age(run.started_at, clock)
    const worker = run.pid && pidAlive(run.pid)
      ? `worker pid ${run.pid} is still alive (the run may be in teardown)`
      : run.pid ? `worker pid ${run.pid} is also gone` : 'worker pid was not recorded'
    return [{
      kind: 'dead-running-process', subject: `run:${run.id}`, since: run.started_at, ageMs,
      detail: `run ${run.id} is running but agent pid ${run.agent_pid} is gone; ` +
        `${worker}; ${elapsedDetail(ageMs)}; output ${run.output_bytes ?? 'unknown'} bytes`,
      action: 'reported; disposition and status repair require intent',
    }]
  })
}

type HubRuling = {
  question_id: number
  task_key: string | null
  session_id: string | null
  asked_at: string
  age: number
}

type HubRulingsPayload = {
  stale_after?: string
  questions?: HubRuling[]
}

/** Report every open question once. `rulings.stale_after` sets severity, not count. */
export function rulingConditions(clock = Date.now()): { conditions: MonitorCondition[]; errors: string[] } {
  const p = Bun.spawnSync([HUB, 'rulings', '--json'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    return { conditions: [], errors: [p.stderr.toString().trim() || `hub rulings exited ${p.exitCode}`] }
  }
  const raw = p.stdout.toString().trim()
  if (!raw) return { conditions: [], errors: ['hub rulings --json produced no document'] }
  let payload: HubRulingsPayload
  try { payload = JSON.parse(raw) as HubRulingsPayload }
  catch { return { conditions: [], errors: ['hub rulings --json was not a JSON document'] } }
  if (!Array.isArray(payload.questions)) {
    return { conditions: [], errors: ['hub rulings --json missing questions array'] }
  }
  const threshold = durationMs(payload.stale_after ?? '1h') ?? 3_600_000
  const conditions = payload.questions.flatMap((row): MonitorCondition[] => {
    if (typeof row.question_id !== 'number' || !Number.isFinite(row.question_id)) return []
    const ageMs = age(row.asked_at, clock)
    if (ageMs == null) return []
    const task = row.task_key ?? '(untracked)'
    const session = row.session_id ?? 'unknown'
    return [{
      kind: 'task-waiting-on-ruling',
      subject: `question:${row.question_id}`,
      since: row.asked_at,
      ageMs,
      detail: `task ${task} waiting on a ruling; session ${session}; ${elapsedDetail(ageMs)}`,
      action: 'reported; it does not answer',
      severity: ageMs >= threshold ? 'attention' : 'informational',
    }]
  }).sort((a, b) => a.detail.localeCompare(b.detail) || a.subject.localeCompare(b.subject))
  return { conditions, errors: [] }
}

/** DEV-211 owns the repair. The monitor invokes its audited command and records its report. */
export function reconcileHub(clock: number): { conditions: MonitorCondition[]; errors: string[] } {
  const p = Bun.spawnSync([HUB, 'reconcile'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    return { conditions: [], errors: [p.stderr.toString().trim() || `hub reconcile exited ${p.exitCode}`] }
  }
  const conditions: MonitorCondition[] = []
  for (const line of p.stdout.toString().split('\n')) {
    const closed = line.match(/^\s*interval (\d+)\s+(orch:\S+).*terminal \(([^)]+)\); removes (\S+) engaged time/)
    if (closed) {
      const ageMs = durationMs(closed[4]!)
      conditions.push({ kind: 'ghost-open-interval', subject: `interval:${closed[1]}`,
        since: ageMs == null ? null : new Date(clock - ageMs).toISOString(), ageMs,
        detail: `${closed[2]} named a terminal run (${closed[3]}) while remaining open`,
        action: 'reconciled through hub reconcile' })
      continue
    }
    const undecided = line.match(/^\s*interval (\d+)\s+(\S+).*needs a decision/)
    if (undecided) conditions.push({ kind: 'open-interval-needs-decision',
      subject: `interval:${undecided[1]}`, since: null, ageMs: null,
      detail: `${undecided[2]} could not be reconciled to authoritative run state`,
      action: 'reported; reconciliation command requested a decision' })
  }
  return { conditions, errors: [] }
}

function dockerConditions(clock: number): { conditions: MonitorCondition[]; errors: string[] } {
  const listed = Bun.spawnSync(['docker', 'volume', 'ls', '--format', '{{.Name}}'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (listed.exitCode !== 0) {
    return { conditions: [], errors: [`docker volume inventory unavailable: ${listed.stderr.toString().trim() || `exit ${listed.exitCode}`}`] }
  }
  // Names are not an ownership proof: project tools may name a volume after a
  // task (`adn-688...`) rather than after its orch run. Inspect labels for all
  // volumes and classify only compose workdirs under vanished worktrees.
  const candidates = listed.stdout.toString().split('\n').filter(Boolean)
  if (!candidates.length) return { conditions: [], errors: [] }
  const inspected = Bun.spawnSync(['docker', 'volume', 'inspect', ...candidates], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (inspected.exitCode !== 0) {
    return { conditions: [], errors: [`docker volume inspection unavailable: ${inspected.stderr.toString().trim() || `exit ${inspected.exitCode}`}`] }
  }
  const rows = JSON.parse(inspected.stdout.toString()) as {
    Name: string; CreatedAt?: string; Labels?: Record<string, string> | null
  }[]
  const liveTrees = new Set(liveRuns().flatMap((row) => row.worktree ? [row.worktree] : []))
  const ownedRoots = projects().map((project) => `${join(project.path, '.claude', 'worktrees')}/`)
  const conditions = rows.flatMap((row): MonitorCondition[] => {
    const workingDir = row.Labels?.['com.docker.compose.project.working_dir'] ?? null
    if (!workingDir || !ownedRoots.some((root) => workingDir.startsWith(root)) ||
        existsSync(workingDir) || liveTrees.has(workingDir)) return []
    const since = row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null
    return [{ kind: 'orphan-docker-volume', subject: row.Name, since,
      ageMs: age(since, clock), detail: `compose worktree is gone: ${workingDir}`,
      action: 'reported; no established removal verb' }]
  })
  return { conditions, errors: [] }
}

/** Observe machine state, record the pass, and make no judgement-shaped repair. */
export async function monitor(trigger: 'invoked' | 'backstop' = 'invoked', clock = Date.now()): Promise<MonitorResult> {
  const database = writableDb()
  const startedAt = new Date(clock).toISOString()
  const invocationRow = database.query(
    'INSERT INTO monitor_invocation (started_at, trigger) VALUES (?,?) RETURNING id',
  ).get(startedAt, trigger) as { id: number }
  const invocation = invocationRow.id
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  const canonRows = allInjectChecks()
  const canon = {
    findings: canonRows.reduce((n, row) => n + row.findings.filter((finding) => finding.kind !== 'unchecked').length, 0),
    docs: canonRows.filter((row) => row.findings.some((finding) => finding.kind !== 'unchecked')).length,
  }
  const add = (condition: Omit<MonitorCondition, 'ageMs'> & { ageMs?: number | null }) =>
    conditions.push({ ...condition, ageMs: condition.ageMs ?? age(condition.since, clock) })
  const reclaimProject = projectAt(process.cwd())

  const asking = database.query(
    `SELECT id, started_at, session_id FROM run WHERE status='asking'
      AND NOT EXISTS (
        SELECT 1 FROM question q WHERE q.run_id = run.id AND q.answered_at IS NULL
      )`,
  ).all() as { id: number; started_at: string; session_id: string | null }[]
  for (const run of asking) add({ kind: 'asking-run', subject: `run:${run.id}`, since: run.started_at,
    detail: `run ${run.id} is waiting on a ruling; session ${run.session_id ?? 'unknown'}`,
    action: 'reported; abandoning or resuming is an intent decision' })

  conditions.push(...deadRunningProcessConditions(clock))
  conditions.push(...idleRunConditions(clock))

  const stale = database.query(
    `SELECT id, started_at, error FROM run WHERE status='stale'`,
  ).all() as { id: number; started_at: string; error: string | null }[]
  for (const run of stale) add({ kind: 'stale-run', subject: `run:${run.id}`, since: run.started_at,
    detail: run.error ?? `run ${run.id} is stale`, action: 'reported; disposition requires intent' })

  const unscored = database.query(
    `SELECT r.id, r.started_at FROM run r LEFT JOIN score s ON s.run_id=r.id WHERE ${UNSCORED_WHERE}`,
  ).all() as { id: number; started_at: string }[]
  for (const run of unscored) add({ kind: 'unscored-run', subject: `run:${run.id}`, since: run.started_at,
    detail: `completed run ${run.id} has no score`, action: 'reported; only its owning reader may score it' })

  for (const project of projects()) {
    for (const lockName of ['create', 'landing', 'cleanup']) {
      try {
        const state = projectLockState(project.path, lockName)
        if (state.holder && !pidAlive(state.holder.pid)) add({ kind: 'dead-lock',
          subject: state.path, since: state.holder.since,
          detail: `${project.name} ${lockName} lock belongs to dead pid ${state.holder.pid}`,
          action: 'reported; no standalone reclaim command exists', affectedProject: project.name })
      } catch (cause) { errors.push(`${project.name} lock inventory: ${String((cause as Error).message ?? cause)}`) }
    }

    try {
      for (const lock of gitLocks(project.path, clock)) {
        const owner = lock.ownerPids === null ? 'owner pid could not be inspected'
          : lock.ownerPids.length ? `owner pid ${lock.ownerPids.join(', ')} is alive`
          : 'no owning pid is alive'
        const resolved = lock.contentRefs.length ? `; resolves to ${lock.contentRefs.join(', ')}` : ''
        add({ kind: lock.ownerPids === null || lock.ownerPids.length ? 'git-lock' : 'dead-lock',
          subject: lock.path,
          since: lock.since,
          detail: `${project.name} git lock targets ${lock.target ?? 'an unknown primitive'}; ` +
            `contents ${lock.contents || '(empty)'}${resolved}; ${owner}`,
          action: 'reported; lock and its recoverable contents were not removed',
          affectedProject: project.name })
      }
    } catch (cause) {
      errors.push(`${project.name} git lock inventory: ${String((cause as Error).message ?? cause)}`)
    }

    const root = join(project.path, '.claude', 'worktrees')
    if (existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = realpathSync(join(root, entry.name))
      const live = database.query(
        `SELECT 1 FROM run WHERE worktree=? AND status IN ('running','asking') LIMIT 1`,
      ).get(path)
      const since = new Date(statSync(path).mtimeMs).toISOString()
      if (!live) {
        let action: string
        if (reclaimProject?.name !== project.name) {
          action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
        } else {
          try { action = reclaimWorktree(path, { clock }).action }
          catch (cause) { action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}` }
        }
        add({ kind: 'worktree-without-live-run', subject: path, since,
          detail: `${project.name} worktree has no running or asking run`, action,
          affectedProject: project.name })
      }
    }

    const worktreeRefs = new Set((git(project.path, ['worktree', 'list', '--porcelain']) ?? '')
      .split('\n').filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.slice(18)))
    const branches = database.query(
      `SELECT DISTINCT branch, MIN(started_at) started_at FROM run
        WHERE repo=? AND branch IS NOT NULL GROUP BY branch`,
    ).all(project.name) as { branch: string; started_at: string }[]
    for (const branch of branches) {
      if (worktreeRefs.has(branch.branch)) continue
      if (git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch.branch}`]) === null) continue
      const subject = `${project.name}:${branch.branch}`
      let action: string
      if (reclaimProject?.name !== project.name) {
        action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
      } else {
        try { action = reclaimBranch(subject).action }
        catch (cause) { action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}` }
      }
      add({ kind: 'branch-without-worktree', subject,
        since: branch.started_at, detail: `${project.name} branch ${branch.branch} has no worktree`,
        action, affectedProject: project.name })
    }
  }

  const hub = reconcileHub(clock)
  conditions.push(...hub.conditions)
  errors.push(...hub.errors)
  const rulings = rulingConditions(clock)
  conditions.push(...rulings.conditions)
  errors.push(...rulings.errors)
  const docker = dockerConditions(clock)
  conditions.push(...docker.conditions)
  errors.push(...docker.errors)

  for (const drift of storedPackDrift()) add({
    kind: 'canon-pack-drift', subject: `${drift.job}/${drift.project ?? '_'}`, since: null,
    detail: `${drift.removed.length} docs removed; ${drift.bytesDelta} bytes versus stored pack`,
    action: 'reported; dispatch is not blocked by pack drift',
  })

  // A tool that could not look has not established emptiness. Persist the
  // exact refusal beside findings so history is useful after launchd's process
  // log has rotated away.
  errors.forEach((detail, index) => add({ kind: 'observation-error',
    subject: `invocation:${invocation}:${index + 1}`, since: startedAt, detail,
    action: 'reported; no state was inferred from the unavailable observation' }))

  const insert = database.query(
    `INSERT INTO monitor_condition
      (invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key,severity)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
  for (const c of conditions) insert.run(invocation, c.kind, c.subject, c.since, c.ageMs,
    c.detail, c.action, c.issueKey ?? null, c.severity ?? null)

  const unavailable = conditions.filter((c) => c.kind === 'detector-unavailable' || c.kind === 'dead-lock')
  for (const condition of unavailable) {
    const prior = database.query(
      `SELECT issue_key FROM monitor_condition
        WHERE kind=? AND subject=? AND issue_key IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).get(condition.kind, condition.subject) as { issue_key: string } | null
    if (prior) { condition.issueKey = prior.issue_key; continue }
    try {
      const filed = await fileIssue({ kind: 'defect',
        title: `Monitor cannot safely handle ${condition.subject}`,
        what_happened: `Monitor cannot safely handle ${condition.subject}: ${condition.detail}`,
        expected: 'The monitor needs a machine-readable detector or an established command so it can report or repair this condition without inference or direct database writes.',
        reproduce_command: 'orch monitor',
        environment: `monitor invocation ${invocation}; affected machine/project is named in the evidence`,
        evidence: `monitor invocation ${invocation}; ${condition.kind} ${condition.subject}; ${condition.detail}`,
        not_established: 'The missing interface design and remediation policy are not established by the monitor.',
      }, { kind: 'monitor', invocationId: invocation,
        affectedProject: condition.affectedProject ?? PLATFORM_SLUG }, PLATFORM_SLUG)
      condition.issueKey = filed.key
      database.query('UPDATE monitor_condition SET issue_key=? WHERE invocation_id=? AND kind=? AND subject=?')
        .run(filed.key, invocation, condition.kind, condition.subject)
    } catch (cause) { errors.push(`could not file ${condition.kind} issue: ${String((cause as Error).message ?? cause)}`) }
  }

  const finishedAt = nowIso()
  database.query('UPDATE monitor_invocation SET finished_at=?, findings=?, errors=? WHERE id=?')
    .run(finishedAt, conditions.length, errors.length, invocation)
  return { id: invocation, startedAt, finishedAt, trigger, conditions, errors, canon }
}

export function monitorHistory(limit = 20): unknown[] {
  return db().query(
    `SELECT i.*, (SELECT json_group_array(json_object(
       'kind',c.kind,'subject',c.subject,'condition_since',c.condition_since,
       'age_ms',c.age_ms,'detail',c.detail,'action',c.action,'issue_key',c.issue_key,
       'severity',c.severity
     )) FROM monitor_condition c WHERE c.invocation_id=i.id) conditions
       FROM monitor_invocation i ORDER BY i.id DESC LIMIT ?`,
  ).all(limit).map((row: any) => ({ ...row, conditions: JSON.parse(row.conditions ?? '[]') }))
}
