import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { allInjectChecks, storedPackDrift } from './canon.ts'
import { db, liveRuns, nowIso, writableDb, writeTransaction } from './db.ts'
import { classifiedDockerResources, dockerRunResources } from './docker-resources.ts'
import { idleLabel, idleMsSince, idleWarnMs } from './events.ts'
import { UNSCORED_WHERE } from './evidence-query.ts'
import { targetGitEnvironment } from './git-environment.ts'
import { gitLocks } from './git-locks.ts'
import { runHasLiveDescendants } from './idle-kill.ts'
import { fileIssue } from './mcp.ts'
import { pidAlive } from './process-liveness.ts'
import { pidRecordIdentity, projectLockState } from './project-lock.ts'
import { projectAt, projects } from './projects.ts'
import { reclaimBranch, reclaimWorktree } from './reclaim.ts'
import {
  refGuardInventory,
  retainedRefInventory,
  worktreeDatabaseInventory,
} from './resource-inventory.ts'
import { terminalDockerRetentionReasonForRun } from './resource-ownership.ts'
import type { MonitorSeverity } from './review-vocabulary.ts'
import { worktreeDirty } from './worktree-attribution.ts'

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
  ownerSession?: string | null
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

const ASKING_RUN_WHERE = `status='asking'
   AND NOT EXISTS (
     SELECT 1 FROM question q WHERE q.run_id = run.id AND q.answered_at IS NULL
   )`

const APPEND_ONLY_DELIVERY_KINDS = new Set([
  'ghost-open-interval',
  'observation-error',
  'stale-run',
])

const REVALIDATED_DELIVERY_KINDS = new Set([
  'asking-run',
  'dead-running-process',
  'idle',
  'task-waiting-on-ruling',
  'terminal-close-out-held',
  'terminal-close-out-failed',
  'unscored-run',
])

type AddressedRun = { id: number; started_at: string; session_id: string | null }

function askingRuns(database = db()): AddressedRun[] {
  return database
    .query(`SELECT id, started_at, session_id FROM run WHERE ${ASKING_RUN_WHERE}`)
    .all() as AddressedRun[]
}

type TerminalCloseOutRun = AddressedRun & {
  close_out_outcome: 'held' | 'failed'
  close_out_detail: string | null
  close_out_attempted_at: string | null
}

function terminalCloseOutRuns(database = db()): TerminalCloseOutRun[] {
  return database
    .query(
      `SELECT id, started_at, close_out_outcome, close_out_detail, close_out_attempted_at, session_id
       FROM run
      WHERE status IN ('ok','failed','stale','stopped')
        AND close_out_outcome IN ('held','failed')`,
    )
    .all() as TerminalCloseOutRun[]
}

function unscoredRuns(database = db()): AddressedRun[] {
  return database
    .query(
      `SELECT r.id, r.started_at, r.session_id
       FROM run r LEFT JOIN score s ON s.run_id=r.id WHERE ${UNSCORED_WHERE}`,
    )
    .all() as AddressedRun[]
}

/** Exactly the fields the human pass line prints, taken from the domain type. */
export type HumanMonitorCondition = Pick<
  MonitorCondition,
  'kind' | 'subject' | 'ageMs' | 'detail' | 'action' | 'issueKey' | 'severity' | 'ownerSession'
>

/** Format one monitor pass identically wherever its human-readable history is printed. */
export function formatMonitorPass(heading: string, conditions: HumanMonitorCondition[]): string[] {
  const lines = [heading]
  if (conditions.some((condition) => condition.kind === 'observation-error')) {
    lines.push('PARTIAL: the condition list is incomplete because one or more observations failed.')
  }
  for (const condition of conditions) {
    const old =
      condition.ageMs == null ? 'age unknown' : `${Math.round(condition.ageMs / 60_000)}m old`
    const sev = condition.severity ? `  ${condition.severity}` : ''
    const owner = condition.ownerSession ? `  owner ${condition.ownerSession}` : ''
    lines.push(
      `  ${condition.kind}${sev}  ${condition.subject}  ${old}${owner}\n    ${condition.detail}\n    ${condition.action}${condition.issueKey ? `; ${condition.issueKey}` : ''}`,
    )
  }
  return lines
}

export type MonitorNotice = Omit<MonitorCondition, 'detail' | 'action'> & {
  noticeId: `condition:${number}` | `landing:${number}`
  detail: string
}

const age = (since: string | null, clock: number) => {
  if (!since) return null
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, clock - at) : null
}

function git(cwd: string, args: string[]): string | null {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
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

/** Report live runs whose vendor stream has gone quiet. The coordinator, not the monitor, checkpoints and terminates past the idle-kill threshold. */
export function idleRunConditions(clock = Date.now()): MonitorCondition[] {
  const threshold = idleWarnMs()
  const running = db()
    .query(
      `SELECT id, started_at, last_event_at, agent, job, session_id FROM run WHERE status='running'`,
    )
    .all() as {
    id: number
    started_at: string
    last_event_at: string | null
    agent: string
    job: string
    session_id: string | null
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    const label = idleLabel(run.last_event_at, run.started_at, clock, threshold)
    if (!label) return []
    const ageMs = idleMsSince(run.last_event_at, run.started_at, clock)
    return [
      {
        kind: 'idle',
        subject: `run:${run.id}`,
        since: run.last_event_at ?? run.started_at,
        ageMs,
        detail: `run ${run.id} ${run.agent}/${run.job} ${label}`,
        action:
          'reported; the run coordinator checkpoints and terminates past the idle-kill threshold',
        ownerSession: run.session_id,
      },
    ]
  })
}

const TERMINAL_RUN_STATUSES = "('ok','failed','stale','stopped')"

/** Report recorded pids and descendants that outlived a terminal run. Observation only. */
export function terminalProcessAliveConditions(clock = Date.now()): MonitorCondition[] {
  const terminal = db()
    .query(
      `SELECT id, started_at, pid, agent_pid, agent_pgid, agent_start_time FROM run
      WHERE status IN ${TERMINAL_RUN_STATUSES}
        AND (pid IS NOT NULL OR agent_pid IS NOT NULL OR agent_pgid IS NOT NULL)`,
    )
    .all() as {
    id: number
    started_at: string
    pid: number | null
    agent_pid: number | null
    agent_pgid: number | null
    agent_start_time: string | null
  }[]
  return terminal.flatMap((run): MonitorCondition[] => {
    const vendorIdentity = pidRecordIdentity(run.agent_pid, run.agent_start_time)
    const coordinatorLive = Boolean(run.pid && run.pid > 1 && pidAlive(run.pid))
    const vendorLive = vendorIdentity === 'live' || vendorIdentity === 'unknown'
    const roots = [
      ...new Set([run.pid, run.agent_pid].filter((pid): pid is number => pid != null && pid > 1)),
    ]
    const descendantsLive = runHasLiveDescendants(
      vendorIdentity === 'reused' ? [run.pid] : roots,
      [],
      {},
      run.agent_pgid,
    )
    if (!coordinatorLive && !vendorLive && !descendantsLive) return []
    const reported =
      (vendorLive && run.agent_pid) ||
      (coordinatorLive && run.pid) ||
      run.agent_pid ||
      run.pid ||
      run.agent_pgid!
    const parts: string[] = []
    if (coordinatorLive) parts.push(`pid ${run.pid}`)
    if (vendorIdentity === 'live') parts.push(`agent pid ${run.agent_pid}`)
    else if (vendorIdentity === 'unknown' && run.agent_pid) {
      parts.push(`agent pid ${run.agent_pid} (identity unverified)`)
    }
    if (descendantsLive && !vendorLive && !coordinatorLive) {
      parts.push(
        run.agent_pgid
          ? `a descendant in pgid ${run.agent_pgid}`
          : `a descendant of pid ${roots.join('/')}`,
      )
    }
    const who = parts.join(' and ') || `a descendant of pid ${roots.join('/')}`
    return [
      {
        kind: 'terminal-process-alive',
        subject: `run:${run.id}:pid:${reported}`,
        since: run.started_at,
        ageMs: age(run.started_at, clock),
        detail: `terminal run ${run.id} still has live ${who}; an unverified process is reported and never killed`,
        action: `run orch close-out ${run.id}; an unverified process is reported and never killed`,
      },
    ]
  })
}

/** Report vendor processes that vanished while their run still claims to be running. */
export function deadRunningProcessConditions(clock = Date.now()): MonitorCondition[] {
  const running = db()
    .query(
      `SELECT id, started_at, pid, agent_pid, output_bytes, session_id FROM run WHERE status='running'`,
    )
    .all() as {
    id: number
    started_at: string
    pid: number | null
    agent_pid: number | null
    output_bytes: number | null
    session_id: string | null
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    // PID reuse makes this deliberately conservative: a reused pid looks live
    // and is not reported. A vendor that has just exited during normal teardown
    // is still an observed condition, not a repair trigger; carry the worker's
    // liveness so the reader can distinguish that transient from a dead worker.
    if (!run.agent_pid || pidAlive(run.agent_pid)) return []
    const ageMs = age(run.started_at, clock)
    const worker =
      run.pid && pidAlive(run.pid)
        ? `worker pid ${run.pid} is still alive (the run may be in teardown)`
        : run.pid
          ? `worker pid ${run.pid} is also gone`
          : 'worker pid was not recorded'
    return [
      {
        kind: 'dead-running-process',
        subject: `run:${run.id}`,
        since: run.started_at,
        ageMs,
        detail:
          `run ${run.id} is running but agent pid ${run.agent_pid} is gone; ` +
          `${worker}; ${elapsedDetail(ageMs)}; output ${run.output_bytes ?? 'unknown'} bytes`,
        action: 'reported; disposition and status repair require intent',
        ownerSession: run.session_id,
      },
    ]
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
export function rulingConditions(clock = Date.now()): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  const p = Bun.spawnSync([HUB, 'rulings', '--json'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    return {
      conditions: [],
      errors: [p.stderr.toString().trim() || `hub rulings exited ${p.exitCode}`],
    }
  }
  const raw = p.stdout.toString().trim()
  if (!raw) return { conditions: [], errors: ['hub rulings --json produced no document'] }
  let payload: HubRulingsPayload
  try {
    payload = JSON.parse(raw) as HubRulingsPayload
  } catch {
    return { conditions: [], errors: ['hub rulings --json was not a JSON document'] }
  }
  if (!Array.isArray(payload.questions)) {
    return { conditions: [], errors: ['hub rulings --json missing questions array'] }
  }
  const threshold = durationMs(payload.stale_after ?? '1h') ?? 3_600_000
  const conditions = payload.questions
    .flatMap((row): MonitorCondition[] => {
      if (typeof row.question_id !== 'number' || !Number.isFinite(row.question_id)) return []
      const ageMs = age(row.asked_at, clock)
      if (ageMs == null) return []
      const task = row.task_key ?? '(untracked)'
      const session = row.session_id ?? 'unknown'
      return [
        {
          kind: 'task-waiting-on-ruling',
          subject: `question:${row.question_id}`,
          since: row.asked_at,
          ageMs,
          detail: `task ${task} waiting on a ruling; session ${session}; ${elapsedDetail(ageMs)}`,
          action: 'reported; it does not answer',
          severity: ageMs >= threshold ? 'attention' : 'informational',
          ownerSession: row.session_id,
        },
      ]
    })
    .sort((a, b) => a.detail.localeCompare(b.detail) || a.subject.localeCompare(b.subject))
  return { conditions, errors: [] }
}

/** DEV-211 owns the repair. The monitor invokes its audited command and records its report. */
export function reconcileHub(clock: number): { conditions: MonitorCondition[]; errors: string[] } {
  const p = Bun.spawnSync([HUB, 'reconcile'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    return {
      conditions: [],
      errors: [p.stderr.toString().trim() || `hub reconcile exited ${p.exitCode}`],
    }
  }
  const conditions: MonitorCondition[] = []
  for (const line of p.stdout.toString().split('\n')) {
    const closed = line.match(
      /^\s*interval (\d+)\s+(orch:\S+).*terminal \(([^)]+)\); removes (\S+) engaged time/,
    )
    if (closed) {
      const ageMs = durationMs(closed[4]!)
      conditions.push({
        kind: 'ghost-open-interval',
        subject: `interval:${closed[1]}`,
        since: ageMs == null ? null : new Date(clock - ageMs).toISOString(),
        ageMs,
        detail: `${closed[2]} named a terminal run (${closed[3]}) while remaining open`,
        action: 'reconciled through hub reconcile',
      })
      continue
    }
    const undecided = line.match(/^\s*interval (\d+)\s+(\S+).*needs a decision/)
    if (undecided)
      conditions.push({
        kind: 'open-interval-needs-decision',
        subject: `interval:${undecided[1]}`,
        since: null,
        ageMs: null,
        detail: `${undecided[2]} could not be reconciled to authoritative run state`,
        action: 'reported; reconciliation command requested a decision',
      })
  }
  return { conditions, errors: [] }
}

function dockerConditions(clock: number): { conditions: MonitorCondition[]; errors: string[] } {
  const listed = Bun.spawnSync(['docker', 'volume', 'ls', '--format', '{{.Name}}'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (listed.exitCode !== 0) {
    return {
      conditions: [],
      errors: [
        `docker volume inventory unavailable: ${listed.stderr.toString().trim() || `exit ${listed.exitCode}`}`,
      ],
    }
  }
  // Names are not an ownership proof: project tools may name a volume after a
  // task (`adn-688...`) rather than after its orch run. Inspect labels for all
  // volumes and classify only compose workdirs under vanished worktrees.
  const candidates = listed.stdout.toString().split('\n').filter(Boolean)
  if (!candidates.length) return { conditions: [], errors: [] }
  const inspected = Bun.spawnSync(['docker', 'volume', 'inspect', ...candidates], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (inspected.exitCode !== 0) {
    return {
      conditions: [],
      errors: [
        `docker volume inspection unavailable: ${inspected.stderr.toString().trim() || `exit ${inspected.exitCode}`}`,
      ],
    }
  }
  const rows = JSON.parse(inspected.stdout.toString()) as {
    Name: string
    CreatedAt?: string
    Labels?: Record<string, string> | null
  }[]
  const liveTrees = new Set(liveRuns().flatMap((row) => (row.worktree ? [row.worktree] : [])))
  const ownedRoots = projects().map((project) => `${join(project.path, '.claude', 'worktrees')}/`)
  const conditions = rows.flatMap((row): MonitorCondition[] => {
    const workingDir = row.Labels?.['com.docker.compose.project.working_dir'] ?? null
    if (
      !workingDir ||
      !ownedRoots.some((root) => workingDir.startsWith(root)) ||
      existsSync(workingDir) ||
      liveTrees.has(workingDir)
    )
      return []
    const since = row.CreatedAt ? new Date(row.CreatedAt).toISOString() : null
    return [
      {
        kind: 'orphan-docker-volume',
        subject: row.Name,
        since,
        ageMs: age(since, clock),
        detail: `compose worktree is gone: ${workingDir}`,
        action: 'reported; no established removal verb',
      },
    ]
  })
  return { conditions, errors: [] }
}

function liveRunIds(database: ReturnType<typeof db>): Set<number> {
  const rows = database.query(`SELECT id FROM run WHERE status IN ('running','asking')`).all() as {
    id: number
  }[]
  return new Set(rows.map((row) => row.id))
}

export function worktreeDatabaseConditions(clock: number): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  const listed = worktreeDatabaseInventory()
  if (!listed.ascertainable) return { conditions: [], errors: [listed.reason] }
  const live = liveRunIds(db())
  const conditions = listed.databases.flatMap((item): MonitorCondition[] => {
    if (live.has(item.runId)) return []
    return [
      {
        kind: 'orphan-worktree-database',
        subject: `${item.engine}:${item.name}`,
        since: null,
        ageMs: age(null, clock),
        detail: `${item.engine} database ${item.name} belongs to ${item.project} run ${item.runId}`,
        action: 'reported; no established removal verb',
        affectedProject: item.project,
      },
    ]
  })
  return { conditions, errors: [] }
}

export function retainedRefConditions(clock: number): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  const listed = retainedRefInventory()
  if (!listed.ascertainable) return { conditions: [], errors: [listed.reason] }
  const live = liveRunIds(db())
  const conditions = listed.items.flatMap((item): MonitorCondition[] => {
    if (live.has(item.runId)) return []
    return [
      {
        kind: 'orphan-retained-ref',
        subject: `${item.project}:${item.ref}`,
        since: null,
        ageMs: age(null, clock),
        detail: `${item.ref} at ${item.sha} pins ${item.project} run ${item.runId}`,
        action: 'reported; no established removal verb',
        affectedProject: item.project,
      },
    ]
  })
  return { conditions, errors: [] }
}

export function refGuardConditions(clock: number): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  const listed = refGuardInventory()
  if (!listed.ascertainable) return { conditions: [], errors: [listed.reason] }
  const live = liveRunIds(db())
  const conditions = listed.items.flatMap((item): MonitorCondition[] => {
    if (live.has(item.runId)) return []
    return [
      {
        kind: 'orphan-ref-guard',
        subject: item.path,
        since: null,
        ageMs: age(null, clock),
        detail: `shared ref-guard metadata for ${item.project} run ${item.runId} remains at ${item.path}`,
        action: 'reported; no established removal verb',
        affectedProject: item.project,
      },
    ]
  })
  return { conditions, errors: [] }
}

/** Observe machine state, record the pass, and make no judgement-shaped repair. */
export async function monitor(
  trigger: 'invoked' | 'backstop' = 'invoked',
  clock = Date.now(),
): Promise<MonitorResult> {
  const database = writableDb()
  const startedAt = new Date(clock).toISOString()
  const invocationRow = database
    .query('INSERT INTO monitor_invocation (started_at, trigger) VALUES (?,?) RETURNING id')
    .get(startedAt, trigger) as { id: number }
  const invocation = invocationRow.id
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  const canonRows = allInjectChecks()
  const canon = {
    findings: canonRows.reduce(
      (n, row) => n + row.findings.filter((finding) => finding.kind !== 'unchecked').length,
      0,
    ),
    docs: canonRows.filter((row) => row.findings.some((finding) => finding.kind !== 'unchecked'))
      .length,
  }
  const add = (condition: Omit<MonitorCondition, 'ageMs'> & { ageMs?: number | null }) =>
    conditions.push({ ...condition, ageMs: condition.ageMs ?? age(condition.since, clock) })
  const reclaimProject = projectAt(process.cwd())

  const asking = askingRuns(database)
  for (const run of asking)
    add({
      kind: 'asking-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: `run ${run.id} is waiting on a ruling; session ${run.session_id ?? 'unknown'}`,
      action: 'reported; abandoning or resuming is an intent decision',
      ownerSession: run.session_id,
    })

  conditions.push(...deadRunningProcessConditions(clock))
  conditions.push(...idleRunConditions(clock))

  const closeOuts = terminalCloseOutRuns(database)
  for (const run of closeOuts)
    add({
      kind: `terminal-close-out-${run.close_out_outcome}`,
      subject: `run:${run.id}`,
      since: run.close_out_attempted_at,
      detail: run.close_out_detail ?? `terminal run ${run.id} close-out ${run.close_out_outcome}`,
      action: `run orch close-out ${run.id}`,
      ownerSession: run.session_id,
    })

  const runDocker = dockerRunResources()
  if (!runDocker.ascertainable) errors.push(runDocker.reason)
  const runDockerResources = runDocker.ascertainable ? runDocker.resources : []
  const dockerOwnerIds = new Set(runDockerResources.map(({ runId }) => runId))
  const dockerOwners = (
    database.query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
    }[]
  ).map((owner) => ({
    ...owner,
    retentionReason: dockerOwnerIds.has(owner.id)
      ? terminalDockerRetentionReasonForRun(database, owner.id)
      : null,
  }))
  for (const item of classifiedDockerResources(runDockerResources, dockerOwners)) {
    if (item.condition !== 'retained-worktree-resources') continue
    add({
      kind: 'retained-worktree-docker-resource',
      subject: item.resource.name,
      since: null,
      severity: 'informational',
      detail:
        `${item.resource.kind} belongs to terminal run ${item.resource.runId}; ` +
        (item.reason
          ? `removal could not be ascertained: ${item.reason}`
          : 'its worktree is retained'),
      action: 'informational; retained resources require review before any removal',
      affectedProject: item.project,
    })
  }

  const stale = database
    .query(`SELECT id, started_at, error, session_id FROM run WHERE status='stale'`)
    .all() as { id: number; started_at: string; error: string | null; session_id: string | null }[]
  for (const run of stale)
    add({
      kind: 'stale-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: run.error ?? `run ${run.id} is stale`,
      action: 'reported; disposition requires intent',
      ownerSession: run.session_id,
    })

  conditions.push(...terminalProcessAliveConditions(clock))

  const unscored = unscoredRuns(database)
  for (const run of unscored)
    add({
      kind: 'unscored-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      detail: `completed run ${run.id} has no score`,
      action: 'reported; only its owning reader may score it',
      ownerSession: run.session_id,
    })

  for (const project of projects()) {
    for (const lockName of ['create', 'cleanup']) {
      try {
        const state = projectLockState(project.path, lockName)
        if (state.holder && !pidAlive(state.holder.pid))
          add({
            kind: 'dead-lock',
            subject: state.path,
            since: state.holder.since,
            detail: `${project.name} ${lockName} lock belongs to dead pid ${state.holder.pid}`,
            action: 'reported; no standalone reclaim command exists',
            affectedProject: project.name,
          })
      } catch (cause) {
        errors.push(`${project.name} lock inventory: ${String((cause as Error).message ?? cause)}`)
      }
    }

    try {
      for (const lock of gitLocks(project.path, clock)) {
        const owner =
          lock.ownerPids === null
            ? 'owner pid could not be inspected'
            : lock.ownerPids.length
              ? `owner pid ${lock.ownerPids.join(', ')} is alive`
              : 'no owning pid is alive'
        const resolved = lock.contentRefs.length
          ? `; resolves to ${lock.contentRefs.join(', ')}`
          : ''
        add({
          kind: lock.ownerPids === null || lock.ownerPids.length ? 'git-lock' : 'dead-lock',
          subject: lock.path,
          since: lock.since,
          detail:
            `${project.name} git lock targets ${lock.target ?? 'an unknown primitive'}; ` +
            `contents ${lock.contents || '(empty)'}${resolved}; ${owner}`,
          action: 'reported; lock and its recoverable contents were not removed',
          affectedProject: project.name,
        })
      }
    } catch (cause) {
      errors.push(
        `${project.name} git lock inventory: ${String((cause as Error).message ?? cause)}`,
      )
    }

    const root = join(project.path, '.claude', 'worktrees')
    if (existsSync(root))
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const path = realpathSync(join(root, entry.name))
        const live = database
          .query(`SELECT 1 FROM run WHERE worktree=? AND status IN ('running','asking') LIMIT 1`)
          .get(path)
        const since = new Date(statSync(path).mtimeMs).toISOString()
        if (!live) {
          let action: string
          if (reclaimProject?.name !== project.name) {
            action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
          } else {
            try {
              action = reclaimWorktree(path, { clock, dryRun: true }).action
            } catch (cause) {
              action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}`
            }
          }
          add({
            kind: 'worktree-without-live-run',
            subject: path,
            since,
            detail: `${project.name} worktree has no running or asking run`,
            action,
            affectedProject: project.name,
          })
        }
      }

    const heldTrees = database
      .query(
        `SELECT MIN(id) id, worktree, MAX(keep_tree) keep_tree, MIN(started_at) started_at
         FROM run WHERE repo=? AND worktree IS NOT NULL
          AND status IN ('ok','failed','stale','stopped')
        GROUP BY worktree`,
      )
      .all(project.name) as {
      id: number
      worktree: string
      keep_tree: number
      started_at: string
    }[]
    for (const held of heldTrees) {
      if (!existsSync(held.worktree)) continue
      const dirty = held.keep_tree ? null : worktreeDirty(held.worktree)
      if (!held.keep_tree && !dirty?.dirty) continue
      const ageMs = age(held.started_at, clock)
      const explicit = Boolean(held.keep_tree)
      add({
        kind: explicit ? 'explicitly-held-worktree' : 'held-worktree',
        subject: held.worktree,
        since: held.started_at,
        detail: explicit
          ? `run ${held.id} retained by explicit --keep-tree`
          : `run ${held.id} ${dirty!.detail}`,
        action: explicit
          ? `clear with orch discard ${held.id}`
          : `commit or remove the work, then run orch close-out ${held.id}`,
        severity: ageMs !== null && ageMs >= 48 * 60 * 60 * 1000 ? 'attention' : 'informational',
      })
    }

    const worktreeRefs = new Set(
      (git(project.path, ['worktree', 'list', '--porcelain']) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice(18)),
    )
    const branches = database
      .query(
        `SELECT minted_branch branch, MIN(started_at) started_at FROM run
        WHERE repo=? AND minted_branch IS NOT NULL GROUP BY minted_branch`,
      )
      .all(project.name) as { branch: string; started_at: string }[]
    for (const branch of branches) {
      if (worktreeRefs.has(branch.branch)) continue
      if (
        git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch.branch}`]) ===
        null
      )
        continue
      const subject = `${project.name}:${branch.branch}`
      let action: string
      if (reclaimProject?.name !== project.name) {
        action = `reported; reclaim refused by monitor scope: ${project.name} is outside invoked project ${reclaimProject?.name ?? 'unknown'}`
      } else {
        try {
          action = reclaimBranch(subject, { dryRun: true }).action
        } catch (cause) {
          action = `reported; reclaim errored: ${String((cause as Error).message ?? cause)}`
        }
      }
      add({
        kind: 'branch-without-worktree',
        subject,
        since: branch.started_at,
        detail: `${project.name} branch ${branch.branch} has no worktree`,
        action,
        affectedProject: project.name,
      })
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
  const worktreeDatabases = worktreeDatabaseConditions(clock)
  conditions.push(...worktreeDatabases.conditions)
  errors.push(...worktreeDatabases.errors)
  const retainedRefs = retainedRefConditions(clock)
  conditions.push(...retainedRefs.conditions)
  errors.push(...retainedRefs.errors)
  const refGuards = refGuardConditions(clock)
  conditions.push(...refGuards.conditions)
  errors.push(...refGuards.errors)

  for (const drift of storedPackDrift())
    add({
      kind: 'canon-pack-drift',
      subject: `${drift.job}/${drift.project ?? '_'}`,
      since: null,
      detail: `${drift.removed.length} docs removed; ${drift.bytesDelta} bytes versus stored pack`,
      action: 'reported; dispatch is not blocked by pack drift',
    })

  // A tool that could not look has not established emptiness. Persist the
  // exact refusal beside findings so history is useful after launchd's process
  // log has rotated away.
  errors.forEach((detail, index) => {
    add({
      kind: 'observation-error',
      subject: `invocation:${invocation}:${index + 1}`,
      since: startedAt,
      detail,
      action: 'reported; no state was inferred from the unavailable observation',
    })
  })

  // Delivery inheritance is one atomic read/write unit. Two monitor passes may
  // otherwise both observe no prior delivery and create duplicate pending rows.
  writeTransaction(() => {
    const insert = database.query(
      `INSERT INTO monitor_condition
        (invocation_id,kind,subject,condition_since,age_ms,detail,action,issue_key,severity,
         owner_session_id,delivered_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const priorDelivery = database.query(
      `SELECT delivered_at FROM monitor_condition
        WHERE kind=? AND subject=? AND condition_since IS ? AND owner_session_id IS ?
          AND delivered_at IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )
    for (const c of conditions) {
      const owner = c.ownerSession ?? null
      const prior = owner
        ? (priorDelivery.get(c.kind, c.subject, c.since, owner) as { delivered_at: string } | null)
        : null
      insert.run(
        invocation,
        c.kind,
        c.subject,
        c.since,
        c.ageMs,
        c.detail,
        c.action,
        c.issueKey ?? null,
        c.severity ?? null,
        owner,
        prior?.delivered_at ?? null,
      )
    }
  }, database)

  const unavailable = conditions.filter(
    (c) => c.kind === 'detector-unavailable' || c.kind === 'dead-lock',
  )
  for (const condition of unavailable) {
    const prior = database
      .query(
        `SELECT issue_key FROM monitor_condition
        WHERE kind=? AND subject=? AND issue_key IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(condition.kind, condition.subject) as { issue_key: string } | null
    if (prior) {
      condition.issueKey = prior.issue_key
      continue
    }
    try {
      const filed = await fileIssue(
        {
          kind: 'defect',
          title: `Monitor cannot safely handle ${condition.subject}`,
          what_happened: `Monitor cannot safely handle ${condition.subject}: ${condition.detail}`,
          expected:
            'The monitor needs a machine-readable detector or an established command so it can report or repair this condition without inference or direct database writes.',
          reproduce_command: 'orch monitor',
          environment: `monitor invocation ${invocation}; affected machine/project is named in the evidence`,
          evidence: `monitor invocation ${invocation}; ${condition.kind} ${condition.subject}; ${condition.detail}`,
          not_established:
            'The missing interface design and remediation policy are not established by the monitor.',
        },
        {
          kind: 'monitor',
          invocationId: invocation,
          affectedProject: condition.affectedProject ?? PLATFORM_SLUG,
        },
        PLATFORM_SLUG,
      )
      condition.issueKey = filed.key
      database
        .query(
          'UPDATE monitor_condition SET issue_key=? WHERE invocation_id=? AND kind=? AND subject=?',
        )
        .run(filed.key, invocation, condition.kind, condition.subject)
    } catch (cause) {
      errors.push(
        `could not file ${condition.kind} issue: ${String((cause as Error).message ?? cause)}`,
      )
    }
  }

  const finishedAt = nowIso()
  database
    .query('UPDATE monitor_invocation SET finished_at=?, findings=?, errors=? WHERE id=?')
    .run(finishedAt, conditions.length, errors.length, invocation)
  return { id: invocation, startedAt, finishedAt, trigger, conditions, errors, canon }
}

export function monitorHistory(limit = 20): unknown[] {
  return db()
    .query(
      `SELECT i.*, (SELECT json_group_array(json_object(
       'kind',c.kind,'subject',c.subject,'condition_since',c.condition_since,
       'age_ms',c.age_ms,'detail',c.detail,'action',c.action,'issue_key',c.issue_key,
       'severity',c.severity
       ,'owner_session_id',c.owner_session_id,'delivered_at',c.delivered_at
     )) FROM monitor_condition c WHERE c.invocation_id=i.id) conditions
       FROM monitor_invocation i ORDER BY i.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row: any) => ({ ...row, conditions: JSON.parse(row.conditions ?? '[]') }))
}

/**
 * Map one stored history row's snake_case condition onto the printable shape.
 * Lives beside monitorHistory so the persisted column names are normalised in
 * one place rather than at each call site that wants to print them.
 */
export function displayConditions(conditions: unknown[]): HumanMonitorCondition[] {
  return conditions.map((raw): HumanMonitorCondition => {
    const condition = raw as {
      kind: string
      subject: string
      age_ms: number | null
      detail: string
      action: string
      issue_key?: string | null
      severity?: MonitorSeverity | null
      owner_session_id?: string | null
    }
    return {
      kind: condition.kind,
      subject: condition.subject,
      ageMs: condition.age_ms,
      detail: condition.detail,
      action: condition.action,
      issueKey: condition.issue_key,
      severity: condition.severity,
      ownerSession: condition.owner_session_id,
    }
  })
}

function deliveredDetail(row: {
  kind: string
  subject: string
  age_ms: number | null
  run_status: string | null
  run_project: string | null
}): string {
  const age = row.age_ms == null ? 'age unknown' : `age ${Math.round(row.age_ms / 60_000)}m`
  const status = row.run_status ? `, status ${row.run_status}` : ''
  const project = row.run_project ? `, project ${row.run_project}` : ''
  return `Orch detected ${row.kind} for ${row.subject} (${age}${status}${project}); inspect the referenced record deliberately.`
}

function landingNoticeDetail(row: {
  id: number
  branch: string
  status: string
  started_at: string
  finished_at: string | null
}): string {
  const started = Date.parse(row.started_at)
  const finished = row.finished_at === null ? started : Date.parse(row.finished_at)
  const elapsed =
    Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, Math.round((finished - started) / 1000))
      : null
  const duration =
    elapsed === null
      ? '?'
      : elapsed >= 60
        ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s`
        : `${elapsed.toFixed(1)}s`
  const event =
    row.status === 'refused'
      ? 'LANDING-REFUSED'
      : row.status === 'rebase_required'
        ? 'LANDING-REBASE-REQUIRED'
        : 'LANDING-INSTALL-FAILED'
  const branch = row.branch.replace(/[\t\r\n]/g, ' ')
  return `${event} ${row.id}/${branch} ${duration}; inspect with 'orch land --status'`
}

function currentAddressedSubjects(kinds: Set<string>): Map<string, Set<string>> {
  for (const kind of kinds) {
    if (!APPEND_ONLY_DELIVERY_KINDS.has(kind) && !REVALIDATED_DELIVERY_KINDS.has(kind)) {
      throw new Error(`monitor notice kind ${kind} has no delivery-currentness policy`)
    }
  }

  const current = new Map<string, Set<string>>()
  const record = (kind: string, subjects: string[]) => current.set(kind, new Set(subjects))
  if (kinds.has('asking-run')) {
    record(
      'asking-run',
      askingRuns().map((run) => `run:${run.id}`),
    )
  }
  if (kinds.has('dead-running-process')) {
    record(
      'dead-running-process',
      deadRunningProcessConditions().map((condition) => condition.subject),
    )
  }
  if (kinds.has('idle')) {
    record(
      'idle',
      idleRunConditions().map((condition) => condition.subject),
    )
  }
  if (kinds.has('task-waiting-on-ruling')) {
    record(
      'task-waiting-on-ruling',
      rulingConditions().conditions.map((condition) => condition.subject),
    )
  }
  if (kinds.has('terminal-close-out-held') || kinds.has('terminal-close-out-failed')) {
    const closeOuts = terminalCloseOutRuns()
    for (const outcome of ['held', 'failed'] as const) {
      const kind = `terminal-close-out-${outcome}`
      if (kinds.has(kind)) {
        record(
          kind,
          closeOuts
            .filter((run) => run.close_out_outcome === outcome)
            .map((run) => `run:${run.id}`),
        )
      }
    }
  }
  if (kinds.has('unscored-run')) {
    record(
      'unscored-run',
      unscoredRuns().map((run) => `run:${run.id}`),
    )
  }
  return current
}

/** Read addressed findings without consuming them. A failed consumer gets them again. */
export function claimMonitorNotices(ownerSession: string): MonitorNotice[] {
  if (!ownerSession.trim()) throw new Error('monitor notices require a session id')
  const rows = db()
    .query(
      `SELECT c.id, c.kind, c.subject, c.condition_since, c.age_ms,
              c.issue_key, c.severity, c.owner_session_id,
              r.status run_status, r.repo run_project
         FROM monitor_condition c
         LEFT JOIN run r ON c.subject=('run:' || r.id)
        WHERE c.owner_session_id=? AND c.delivered_at IS NULL
          AND c.id = (
            SELECT MAX(newest.id) FROM monitor_condition newest
             WHERE newest.kind=c.kind AND newest.subject=c.subject
               AND newest.condition_since IS c.condition_since
               AND newest.owner_session_id=c.owner_session_id
          )
        ORDER BY c.id`,
    )
    .all(ownerSession) as {
    id: number
    kind: string
    subject: string
    condition_since: string | null
    age_ms: number | null
    issue_key: string | null
    severity: MonitorSeverity | null
    owner_session_id: string
    run_status: string | null
    run_project: string | null
  }[]
  const kinds = new Set(rows.map((row) => row.kind))
  const current = currentAddressedSubjects(kinds)
  const conditions = rows
    .filter(
      (row) => APPEND_ONLY_DELIVERY_KINDS.has(row.kind) || current.get(row.kind)?.has(row.subject),
    )
    .map((row) => ({
      noticeId: `condition:${row.id}` as const,
      kind: row.kind,
      subject: row.subject,
      since: row.condition_since,
      ageMs: row.age_ms,
      detail: deliveredDetail(row),
      issueKey: row.issue_key,
      severity: row.severity,
      ownerSession: row.owner_session_id,
    }))
  const landings = db()
    .query(
      `SELECT id, branch, status, started_at, finished_at, session_id
       FROM landing
      WHERE session_id=? AND heartbeat_delivered_at IS NULL
        AND status IN ('refused','rebase_required','install_failed')
      ORDER BY id`,
    )
    .all(ownerSession) as {
    id: number
    branch: string
    status: string
    started_at: string
    finished_at: string | null
    session_id: string
  }[]
  return [
    ...conditions,
    ...landings.map(
      (row): MonitorNotice => ({
        noticeId: `landing:${row.id}`,
        kind: `landing-${row.status.replaceAll('_', '-')}`,
        subject: `landing:${row.id}`,
        since: row.finished_at ?? row.started_at,
        ageMs: null,
        detail: landingNoticeDetail(row),
        ownerSession: row.session_id,
      }),
    ),
  ]
}

/** Acknowledge only rows the hook has already emitted to its consumer. */
export function markMonitorNoticesDelivered(
  ownerSession: string,
  ids: MonitorNotice['noticeId'][],
  deliveredAt = nowIso(),
): void {
  if (!ownerSession.trim()) throw new Error('monitor notice acknowledgement requires a session id')
  const parsed = ids.map((token) => {
    const match = /^(condition|landing):([1-9]\d*)$/.exec(token)
    if (!match)
      throw new Error('monitor notice acknowledgement requires source-qualified notice ids')
    return { source: match[1] as 'condition' | 'landing', id: Number(match[2]) }
  })
  if (!parsed.length || parsed.some(({ id }) => !Number.isSafeInteger(id))) {
    throw new Error('monitor notice acknowledgement requires source-qualified notice ids')
  }
  const database = writableDb()
  writeTransaction(() => {
    const mark = database.query(
      `UPDATE monitor_condition SET delivered_at=? WHERE id=? AND owner_session_id=? AND delivered_at IS NULL`,
    )
    const conditions = new Set(
      parsed.filter(({ source }) => source === 'condition').map(({ id }) => id),
    )
    const landings = new Set(
      parsed.filter(({ source }) => source === 'landing').map(({ id }) => id),
    )
    // A receipt may stamp a landing only when that source-qualified landing token
    // came from the claim that produced the emission. Equal ids in other sources do not qualify.
    for (const id of conditions) mark.run(deliveredAt, id, ownerSession)
    const markLanding = database.query(
      `UPDATE landing SET heartbeat_delivered_at=?
        WHERE id=? AND session_id=? AND heartbeat_delivered_at IS NULL
          AND status IN ('refused','rebase_required','install_failed')`,
    )
    for (const id of landings) markLanding.run(deliveredAt, id, ownerSession)
  }, database)
}
