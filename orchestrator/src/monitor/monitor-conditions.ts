// concern: monitor-conditions
/** Owns monitor condition detection and the row queries and helpers those detectors share with composition and notice revalidation. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type PidRecordIdentity,
  pidAlive,
  processStartTime,
} from '../../../shared/process-identity.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { db, liveRuns } from '../database/db.ts'
import { idleLabel, idleMsSince, idleWarnMs } from '../events.ts'
import { UNSCORED_WHERE } from '../evidence/evidence-query.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { hookTreeNotice } from '../hook-tree/hook-tree.ts'
import { runHasLiveDescendants, sampleProcesses } from '../idle-kill.ts'
import { isProjectRepository, projects } from '../project/projects.ts'
import type { ResourceClaimKind } from '../resources/resource-claims.ts'
import {
  refGuardInventory,
  retainedRefInventory,
  type SandboxDirectoryInventory,
  worktreeDatabaseInventory,
} from '../resources/resource-inventory.ts'

export { sandboxDirectoryInventory } from '../resources/resource-inventory.ts'

import { liveMemberStall, liveRunMembers } from '../run/live-run-member.ts'
import { questionOpenSql } from '../run/question-open.ts'
import { runAlive } from '../run/run-alive.ts'
import { abandonedBootstrap, PENDING_BOOTSTRAP_MS } from '../run/run-bootstrap.ts'
import { runLeaseState } from '../run/run-lease.ts'
import {
  HOOK_TREE_JOB,
  isSyntheticLifecycleJob,
  SYNTHETIC_LIFECYCLE_JOBS,
} from '../run/synthetic-lifecycle-job.ts'
import { idleStallMs } from '../stalled-run.ts'
import type {
  MonitorCondition,
  RecipeDatabaseClaim,
  RecipeDatabaseNamespace,
} from './monitor-types.ts'

const ASKING_RUN_WHERE = `parent_run_id IS NULL
   AND (
     SELECT member.status FROM run member
      WHERE member.id = run.id OR member.parent_run_id = run.id
      ORDER BY member.turn DESC, member.id DESC
      LIMIT 1
   ) = 'asking'
   AND NOT EXISTS (
     SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
      WHERE (owner.id = run.id OR owner.parent_run_id = run.id)
        AND ${questionOpenSql('q')}
   )`

type AddressedRun = { id: number; started_at: string; session_id: string | null }

/** Compare observed namespaces with live claims and map unaccounted names to conditions. */
export function orphanRecipeDatabaseConditions(
  namespace: RecipeDatabaseNamespace,
  claims: readonly RecipeDatabaseClaim[],
): MonitorCondition[] {
  const accounted = new Set(
    claims
      .filter((claim) => claim.state === 'claimed' || claim.state === 'retained')
      .map((claim) => claim.allocationKey),
  )
  const excluded = new Set([
    namespace.sourceName,
    ...(namespace.mainName ? [namespace.mainName] : []),
  ])
  return namespace.names
    .filter((name) => !excluded.has(name) && !accounted.has(`${namespace.engine}:${name}`))
    .map((name) => ({
      kind: 'orphan-recipe-database',
      subject: `${namespace.project}:${namespace.allocationKey}:${namespace.engine}:${name}`,
      since: null,
      ageMs: null,
      detail: `${namespace.project} allocation ${namespace.allocationKey} has unclaimed ${namespace.engine} database ${name}`,
      action: 'report only; verify nothing uses it, then drop it by hand',
      affectedProject: namespace.project,
    }))
}

export function askingRuns(database = db()): AddressedRun[] {
  return database
    .query(`SELECT id, started_at, session_id FROM run WHERE ${ASKING_RUN_WHERE}`)
    .all() as AddressedRun[]
}

type TerminalCloseOutRun = AddressedRun & {
  close_out_outcome: 'held' | 'failed'
  close_out_detail: string | null
  close_out_attempted_at: string | null
}

export function terminalCloseOutRuns(database = db()): TerminalCloseOutRun[] {
  return database
    .query(
      `SELECT id, started_at, close_out_outcome, close_out_detail, close_out_attempted_at, session_id
       FROM run
      WHERE status IN ('ok','failed','stale','stopped')
        AND job NOT IN (${SYNTHETIC_LIFECYCLE_JOBS.map(() => '?').join(',')})
        AND close_out_outcome IN ('held','failed')`,
    )
    .all(...SYNTHETIC_LIFECYCLE_JOBS) as TerminalCloseOutRun[]
}

export function unscoredRuns(database = db()): AddressedRun[] {
  return database
    .query(
      `SELECT r.id, r.started_at, r.session_id
       FROM run r LEFT JOIN score s ON s.run_id=r.id WHERE ${UNSCORED_WHERE}`,
    )
    .all() as AddressedRun[]
}

/** Report terminal stale rows that have not yet been settled out of evidence. */
export function staleRunConditions(database = db(), clock = Date.now()): MonitorCondition[] {
  const rows = database
    .query(
      `SELECT id, started_at, error, session_id FROM run
        WHERE status='stale' AND evidence_excluded IS NULL`,
    )
    .all() as { id: number; started_at: string; error: string | null; session_id: string | null }[]
  return rows.map((run) => ({
    kind: 'stale-run',
    subject: `run:${run.id}`,
    since: run.started_at,
    ageMs: age(run.started_at, clock),
    detail: run.error ?? `run ${run.id} is stale`,
    action: `run orch reclaim stale-run ${run.id} --dry-run, then orch reclaim stale-run ${run.id}`,
    ownerSession: run.session_id,
  }))
}

export const age = (since: string | null, clock: number) => {
  if (!since) return null
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, clock - at) : null
}

export function hookTreeConditions(database = db(), clock = Date.now()): MonitorCondition[] {
  const rows = database
    .query(
      `SELECT id,job,status,worktree path,started_at FROM run
       WHERE job=? AND worktree IS NOT NULL ORDER BY id`,
    )
    .all(HOOK_TREE_JOB) as {
    id: number
    job: string
    status: string
    path: string
    started_at: string
  }[]
  return rows.flatMap((row) => {
    const condition = hookTreeNotice({ ...row, startedAt: row.started_at }, clock)
    return condition ? [condition] : []
  })
}

export function git(cwd: string, args: string[]): string | null {
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
  if (!match) return null
  const [, amount, unit] = match
  if (!amount || !unit) return null
  const multiplier = units[unit]
  return multiplier === undefined ? null : Math.round(Number(amount) * multiplier)
}

function elapsedDetail(elapsedMs: number | null): string {
  if (elapsedMs == null) return 'elapsed time unknown'
  if (elapsedMs < 60_000) return `elapsed ${Math.round(elapsedMs / 1000)}s`
  if (elapsedMs < 3_600_000) return `elapsed ${Math.round(elapsedMs / 60_000)}m`
  return `elapsed ${(elapsedMs / 3_600_000).toFixed(1)}h`
}

type IdleRunFacts = {
  id: number
  started_at: string
  last_event_at: string | null
  agent: string
  job: string
  session_id: string | null
  pidAlive: boolean | null
}

/** Classify one running row from already-observed process and elapsed-time facts. */
export function idleRunCondition(
  run: IdleRunFacts,
  clock = Date.now(),
  threshold = idleWarnMs(),
): MonitorCondition | null {
  if (run.pidAlive === false) {
    return {
      kind: 'stale-run',
      subject: `run:${run.id}`,
      since: run.started_at,
      ageMs: age(run.started_at, clock),
      detail: `run ${run.id} is running but its recorded pid is gone; no terminal state was recorded`,
      action: `run orch stop ${run.id}`,
      ownerSession: run.session_id,
    }
  }
  const label = idleLabel(run.last_event_at, run.started_at, clock, threshold)
  if (!label) return null
  return {
    kind: 'idle',
    subject: `run:${run.id}`,
    since: run.last_event_at ?? run.started_at,
    ageMs: idleMsSince(run.last_event_at, run.started_at, clock),
    detail: `run ${run.id} ${run.agent}/${run.job} ${label}`,
    action: 'reported; the run coordinator checkpoints and terminates past the idle-kill threshold',
    ownerSession: run.session_id,
  }
}

/** Report live runs whose vendor stream has gone quiet. The coordinator, not the monitor, checkpoints and terminates past the idle-kill threshold. */
export function idleRunConditions(clock = Date.now()): MonitorCondition[] {
  const running = db()
    .query(
      `SELECT id, started_at, last_event_at, agent, job, session_id, pid FROM run WHERE status='running'`,
    )
    .all() as {
    id: number
    started_at: string
    last_event_at: string | null
    agent: string
    job: string
    session_id: string | null
    pid: number | null
  }[]
  return running.flatMap((run): MonitorCondition[] => {
    const condition = idleRunCondition(
      {
        ...run,
        pidAlive: run.pid === null ? null : pidAlive(run.pid),
      },
      clock,
    )
    return condition ? [condition] : []
  })
}

/** Report silent, CPU-idle workers without changing their lifecycle. */
export function stalledRunConditions(
  clock = Date.now(),
  deps: {
    samples?: ReturnType<typeof sampleProcesses>
    observedStartTime?: (pid: number) => string | null
  } = {},
): MonitorCondition[] {
  const running = liveRunMembers()
  const samples = deps.samples ?? (running.length ? sampleProcesses() : [])
  return running.flatMap((run): MonitorCondition[] => {
    const observed = liveMemberStall(run, samples, clock, idleStallMs(), deps.observedStartTime)
    if (observed.state !== 'stalled' || observed.idleMs === null || observed.detail === null)
      return []
    return [
      {
        kind: 'stalled-run',
        subject: `run:${run.id}`,
        since: run.last_event_at ?? run.started_at,
        ageMs: observed.idleMs,
        detail: observed.detail,
        action: `run orch stop ${run.id}, then re-dispatch; otherwise wait for the idle bound`,
        ownerSession: run.session_id,
      },
    ]
  })
}

const TERMINAL_RUN_STATUSES = "('ok','failed','stale','stopped')"
const TERMINAL_RUN_STATUS_SET = new Set(['ok', 'failed', 'stale', 'stopped'])
const PID_BIRTH_TOLERANCE_MS = 2_000

/** A pid born well after terminal completion belongs to a later process incarnation. */
export function pidBornAfterRun(birth: string | null, finishedAt: number | null): boolean {
  if (birth === null || finishedAt === null) return false
  const bornAt = Date.parse(birth)
  return Number.isFinite(bornAt) && bornAt > finishedAt + PID_BIRTH_TOLERANCE_MS
}

/** A reused vendor pid means its recorded process group is no longer ours either. */
export function terminalProcessPgid(
  vendorIdentity: PidRecordIdentity,
  agentPgid: number | null,
): number | null {
  return vendorIdentity === 'reused' ? null : agentPgid
}

type TerminalProcessRun = {
  id: number
  started_at: string
  latency_ms: number | null
  pid: number | null
  agent_pid: number | null
  agent_pgid: number | null
  agent_start_time: string | null
}

type TerminalProcessStateDeps = {
  alive: (pid: number) => boolean
  observedStartTime: (pid: number) => string | null
}

function terminalPidObservation(
  pid: number | null,
  deps: TerminalProcessStateDeps,
): { alive: boolean; birth: string | null } {
  const alive = Boolean(pid && deps.alive(pid))
  return { alive, birth: pid && alive ? deps.observedStartTime(pid) : null }
}

function terminalVendorIdentity(
  run: TerminalProcessRun,
  alive: boolean,
  birth: string | null,
  finishedAt: number | null,
): PidRecordIdentity {
  if (pidBornAfterRun(birth, finishedAt)) return 'reused'
  if (!run.agent_pid || run.agent_pid <= 1 || !alive) return 'dead'
  if (!run.agent_start_time || birth === null) return 'unknown'
  return birth === run.agent_start_time ? 'live' : 'reused'
}

/** Classify one terminal run from supplied process observations. */
export function terminalProcessState(
  run: TerminalProcessRun,
  deps: TerminalProcessStateDeps = {
    alive: pidAlive,
    observedStartTime: processStartTime,
  },
) {
  const startedAt = Date.parse(run.started_at)
  const finishedAt =
    run.latency_ms !== null && Number.isFinite(startedAt) ? startedAt + run.latency_ms : null
  const coordinator = terminalPidObservation(run.pid, deps)
  const vendor = terminalPidObservation(run.agent_pid, deps)
  const coordinatorReused = pidBornAfterRun(coordinator.birth, finishedAt)
  const vendorIdentity = terminalVendorIdentity(run, vendor.alive, vendor.birth, finishedAt)
  const coordinatorLive = Boolean(run.pid && run.pid > 1 && !coordinatorReused && coordinator.alive)
  const roots = [
    ...new Set(
      [
        coordinatorReused ? null : run.pid,
        vendorIdentity === 'reused' ? null : run.agent_pid,
      ].filter((pid): pid is number => pid != null && pid > 1),
    ),
  ]
  const pgid = terminalProcessPgid(vendorIdentity, run.agent_pgid)
  return { coordinatorLive, vendorIdentity, roots, pgid }
}

export type TerminalProcessResidueObservation = {
  runId: number
  liveness: 'dead' | 'live' | 'unknown'
  condition: MonitorCondition
}

/** Observe recorded pids and descendants that outlived a terminal run. Never mutates them. */
export function terminalProcessResidueObservations(
  clock = Date.now(),
  deps: {
    sample?: typeof sampleProcesses
    alive?: (pid: number) => boolean
    observedStartTime?: (pid: number) => string | null
  } = {},
): TerminalProcessResidueObservation[] {
  const terminal = db()
    .query(
      `SELECT id, started_at, latency_ms, pid, agent_pid, agent_pgid, agent_start_time FROM run
      WHERE status IN ${TERMINAL_RUN_STATUSES}
        AND (pid IS NOT NULL OR agent_pid IS NOT NULL OR agent_pgid IS NOT NULL)`,
    )
    .all() as TerminalProcessRun[]
  const samples = terminal.length ? (deps.sample ?? sampleProcesses)() : []
  const stateDeps: TerminalProcessStateDeps = {
    alive: deps.alive ?? pidAlive,
    observedStartTime: deps.observedStartTime ?? processStartTime,
  }
  return terminal.flatMap((run): TerminalProcessResidueObservation[] => {
    const { coordinatorLive, vendorIdentity, roots, pgid } = terminalProcessState(run, stateDeps)
    const vendorLive = vendorIdentity === 'live' || vendorIdentity === 'unknown'
    const descendantsLive = runHasLiveDescendants(
      roots,
      [],
      { sample: () => samples, alive: stateDeps.alive },
      pgid,
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
        runId: run.id,
        // An identity-unverified live pid remains operator-only. Its record is
        // released unattended only after a fresh observation proves it gone.
        liveness:
          vendorIdentity === 'unknown'
            ? 'unknown'
            : coordinatorLive || vendorIdentity === 'live' || descendantsLive
              ? 'live'
              : 'dead',
        condition: {
          kind: 'terminal-process-alive',
          subject: `run:${run.id}:pid:${reported}`,
          since: run.started_at,
          ageMs: age(run.started_at, clock),
          detail: `terminal run ${run.id} still has live ${who}; an unverified process is reported and never killed`,
          action: `run orch reclaim process ${run.id} --dry-run, then orch reclaim process ${run.id}`,
        },
      },
    ]
  })
}

/** Report recorded pids and descendants that outlived a terminal run. Observation only. */
export function terminalProcessAliveConditions(clock = Date.now()): MonitorCondition[] {
  return terminalProcessResidueObservations(clock).map(({ condition }) => condition)
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
    const lease = runLeaseState(run.id)
    const coordinatorAlive = runAlive({
      status: 'running',
      lease,
      pidAlive: Boolean(run.pid && pidAlive(run.pid)),
    })
    const worker = coordinatorAlive
      ? lease === 'held'
        ? `run ${run.id} coordinator lease is held (the run may be in teardown)`
        : `legacy worker pid ${run.pid} is still alive (the run may be in teardown)`
      : lease === 'free'
        ? `run ${run.id} coordinator lease is free`
        : run.pid
          ? `legacy worker pid ${run.pid} is also gone`
          : 'legacy worker pid was not recorded'
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

/** Report reserved rows whose coordinator never completed the launch handoff. */
export function abandonedBootstrapConditions(clock = Date.now()): MonitorCondition[] {
  const pending = db()
    .query(
      `SELECT id, started_at, pid, agent, session_id
       FROM run WHERE status='running' AND agent='(pending)'`,
    )
    .all() as {
    id: number
    started_at: string
    pid: number | null
    agent: string
    session_id: string | null
  }[]
  return pending.flatMap((run): MonitorCondition[] => {
    const leaseState = runLeaseState(run.id)
    if (
      !abandonedBootstrap({
        agent: run.agent,
        pid: run.pid,
        pidAlive: Boolean(run.pid && pidAlive(run.pid)),
        leaseState,
        startedAt: run.started_at,
        now: clock,
      })
    ) {
      return []
    }
    const cause =
      run.pid === null
        ? 'has no coordinator pid'
        : leaseState === 'free'
          ? `has a free coordinator lease and recorded pid ${run.pid}`
          : `has dead coordinator pid ${run.pid}`
    return [
      {
        kind: 'abandoned-bootstrap',
        subject: `run:${run.id}`,
        since: run.started_at,
        ageMs: age(run.started_at, clock),
        detail: `pending run ${run.id} ${cause} after the ${PENDING_BOOTSTRAP_MS}ms launch grace`,
        action: 'run orch sweep to terminalize the abandoned bootstrap',
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
  const p = Bun.spawnSync([...bottegaEntryArgv('hub'), 'rulings', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
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
          action: ['sess-a', 'sess-b', 'sess-old', 'sess-probe'].includes(session)
            ? 'run orch reclaim fixture-questions --dry-run, then orch reclaim fixture-questions'
            : 'reported; it does not answer',
          severity: ageMs >= threshold ? 'attention' : 'informational',
          ownerSession: row.session_id,
        },
      ]
    })
    .sort((a, b) => a.detail.localeCompare(b.detail) || a.subject.localeCompare(b.subject))
  return { conditions, errors: [] }
}

/** The hub reconciler owns the repair; the monitor invokes it and records its report. */
export function reconcileHub(clock: number): { conditions: MonitorCondition[]; errors: string[] } {
  const p = Bun.spawnSync([...bottegaEntryArgv('hub'), 'reconcile'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
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

export function dockerConditions(clock: number): {
  conditions: MonitorCondition[]
  errors: string[]
} {
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
  const ownedRoots = projects()
    .filter(isProjectRepository)
    .map((project) => `${join(project.path, '.claude', 'worktrees')}/`)
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
  const rows = database
    .query(`SELECT id,status,pid FROM run WHERE status IN ('running','asking')`)
    .all() as { id: number; status: string; pid: number | null }[]
  return new Set(
    rows
      .filter((row) =>
        runAlive({
          status: row.status,
          lease: runLeaseState(row.id),
          pidAlive: Boolean(row.pid && pidAlive(row.pid)),
        }),
      )
      .map((row) => row.id),
  )
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
        action: `run orch reclaim retained-ref ${item.project}:${item.runId} --dry-run, then orch reclaim retained-ref ${item.project}:${item.runId}`,
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
        action: `run orch reclaim ref-guard ${item.project}:${item.runId} --dry-run, then orch reclaim ref-guard ${item.project}:${item.runId}`,
        affectedProject: item.project,
      },
    ]
  })
  return { conditions, errors: [] }
}

type DockerNetworkOwner = {
  rootId: number
  terminal: boolean
  hasWorktree: boolean
}

export type ObservedDockerNetworkInventory =
  | {
      ascertainable: true
      networks: {
        name: string
        createdAt: string | null
        workingDir: string | null
        runId: number | null
        workingDirExists: boolean
      }[]
      owners: DockerNetworkOwner[]
    }
  | { ascertainable: false; reason: string }

/** Decide which observed Compose networks have no remaining worktree owner. */
export function orphanDockerNetworkConditions(
  inventory: ObservedDockerNetworkInventory,
  clock: number,
): { conditions: MonitorCondition[]; errors: string[] } {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const owners = new Map(inventory.owners.map((owner) => [owner.rootId, owner]))
  const conditions = inventory.networks.flatMap((network): MonitorCondition[] => {
    const vanishedWorkdir = network.workingDir !== null && !network.workingDirExists
    const owner = network.runId === null ? null : owners.get(network.runId)
    const terminalOwnerWithoutTree = Boolean(owner?.terminal && !owner.hasWorktree)
    if (!vanishedWorkdir && !terminalOwnerWithoutTree) return []
    const since = network.createdAt ? new Date(network.createdAt).toISOString() : null
    const evidence = vanishedWorkdir
      ? `compose working directory is gone: ${network.workingDir}`
      : `terminal conversation ${network.runId} has no worktree`
    return [
      {
        kind: 'orphan-docker-network',
        subject: network.name,
        since,
        ageMs: age(since, clock),
        detail: `Docker network ${network.name}; ${evidence}`,
        action: 'reported; no established removal verb',
      },
    ]
  })
  return { conditions, errors: [] }
}

/** Report sandbox homes only after every turn in their conversation is terminal. */
export function orphanSandboxDirectoryConditions(inventory: SandboxDirectoryInventory): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const conversations = new Map(
    inventory.conversations.map((conversation) => [conversation.rootId, conversation]),
  )
  const conditions = inventory.directories.flatMap((directory): MonitorCondition[] => {
    if (!conversations.get(directory.rootId)?.terminal) return []
    return [
      {
        kind: 'orphan-sandbox-dir',
        subject: directory.path,
        since: null,
        ageMs: null,
        detail: `sandbox directory for terminal conversation ${directory.rootId} uses ${directory.sizeBytes} bytes`,
        action: `run orch reclaim sandbox ${directory.rootId} --dry-run, then orch reclaim sandbox ${directory.rootId}`,
      },
    ]
  })
  return { conditions, errors: [] }
}

export type TrustEntryInventory =
  | {
      ascertainable: true
      entries: {
        runId: number
        heading: string
        path: string | null
        pathExists: boolean
        registeredProjectPath: boolean
        worktreeExists: boolean
      }[]
    }
  | { ascertainable: false; reason: string }

function trustHeadingStale(facts: {
  path: string | null
  pathExists: boolean
  registeredProjectPath: boolean
  worktreeExists: boolean
}): boolean {
  return (
    facts.path !== null &&
    !facts.pathExists &&
    !facts.registeredProjectPath &&
    !facts.worktreeExists
  )
}

/** Report recorded vendor trust headings after the run's worktree is gone. */
export function staleTrustEntryConditions(inventory: TrustEntryInventory): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const conditions = inventory.entries.flatMap((entry): MonitorCondition[] => {
    if (!trustHeadingStale(entry)) return []
    return [
      {
        kind: 'stale-trust-entry',
        subject: `run:${entry.runId}:${entry.heading}`,
        since: null,
        ageMs: null,
        detail: `run ${entry.runId} recorded Grok trust heading ${entry.heading} after its worktree disappeared`,
        action: `run orch reclaim trust ${entry.runId} --dry-run, then orch reclaim trust ${entry.runId}`,
      },
    ]
  })
  const errors = inventory.entries.flatMap((entry) =>
    entry.path === null
      ? [`run ${entry.runId} recorded Grok trust heading without a quoted path: ${entry.heading}`]
      : [],
  )
  return { conditions, errors }
}

type TerminalConversationTurn = {
  started_at: string
  latency_ms: number | null
  last_event_at: string | null
}

/** Last-turn terminal time: started_at plus latency_ms, else last_event_at, else started_at. */
export function terminalConversationTime(turn: TerminalConversationTurn): string | null {
  const startedAt = Date.parse(turn.started_at)
  const startedValid = Number.isFinite(startedAt)
  if (startedValid && turn.latency_ms !== null && Number.isFinite(turn.latency_ms)) {
    return new Date(startedAt + turn.latency_ms).toISOString()
  }
  if (turn.last_event_at !== null) {
    const lastEventAt = Date.parse(turn.last_event_at)
    if (Number.isFinite(lastEventAt)) return new Date(lastEventAt).toISOString()
  }
  if (startedValid) return new Date(startedAt).toISOString()
  return null
}

export type UnsettledClaimInventory =
  | {
      ascertainable: true
      claims: {
        kind: ResourceClaimKind
        rootId: number
        allocationKeys: string[]
        terminal: boolean
        terminalAt: string | null
      }[]
      errors?: string[]
    }
  | { ascertainable: false; reason: string }

/** Read claimed allocations with the terminal time of their complete conversation. */
export function unsettledClaimInventory(database = db()): UnsettledClaimInventory {
  try {
    const claims = database
      .query(
        `SELECT root_run_id,kind,allocation_key FROM resource_claim
         WHERE state='claimed' ORDER BY root_run_id,kind,allocation_key`,
      )
      .all() as { root_run_id: number; kind: ResourceClaimKind; allocation_key: string }[]
    const turns = database
      .query(
        `SELECT id,parent_run_id,turn,status,started_at,latency_ms,last_event_at,job FROM run
         ORDER BY COALESCE(parent_run_id,id),turn,id`,
      )
      .all() as {
      id: number
      parent_run_id: number | null
      turn: number
      status: string
      started_at: string
      latency_ms: number | null
      last_event_at: string | null
      job: string
    }[]
    const byRoot = new Map<number, typeof turns>()
    for (const turn of turns) {
      const rootId = turn.parent_run_id ?? turn.id
      byRoot.set(rootId, [...(byRoot.get(rootId) ?? []), turn])
    }
    const grouped = new Map<
      string,
      {
        kind: ResourceClaimKind
        rootId: number
        allocationKeys: string[]
        terminal: boolean
        terminalAt: string | null
      }
    >()
    const unresolvable = new Set<number>()
    for (const claim of claims) {
      if (byRoot.get(claim.root_run_id)?.some((turn) => isSyntheticLifecycleJob(turn.job))) continue
      const key = `${claim.kind}:${claim.root_run_id}`
      const conversation = byRoot.get(claim.root_run_id) ?? []
      const terminal =
        conversation.length > 0 &&
        conversation.every((turn) => TERMINAL_RUN_STATUS_SET.has(turn.status))
      const last = conversation.at(-1)
      let terminalAt: string | null = null
      if (terminal && last) {
        terminalAt = terminalConversationTime(last)
        if (terminalAt === null) unresolvable.add(claim.root_run_id)
      }
      const current = grouped.get(key) ?? {
        kind: claim.kind,
        rootId: claim.root_run_id,
        allocationKeys: [],
        terminal,
        terminalAt,
      }
      current.allocationKeys.push(claim.allocation_key)
      grouped.set(key, current)
    }
    return {
      ascertainable: true,
      claims: [...grouped.values()],
      errors: [...unresolvable].map(
        (rootId) => `terminal time for conversation ${rootId} could not be established`,
      ),
    }
  } catch (error) {
    return {
      ascertainable: false,
      reason: `unsettled claim inventory unavailable: ${String((error as Error).message ?? error)}`,
    }
  }
}

/** Report claimed allocations after their conversation has been terminal for more than one hour. */
export function unsettledClaimConditions(
  inventory: UnsettledClaimInventory,
  clock: number,
): { conditions: MonitorCondition[]; errors: string[] } {
  if (!inventory.ascertainable) return { conditions: [], errors: [inventory.reason] }
  const conditions = inventory.claims.flatMap((claim): MonitorCondition[] => {
    if (!claim.terminal || !claim.terminalAt) return []
    const ageMs = age(claim.terminalAt, clock)
    if (ageMs === null || ageMs <= 3_600_000) return []
    const allocations = claim.allocationKeys.join(', ')
    return [
      {
        kind: 'unsettled-claim',
        subject: `${claim.kind}:${claim.rootId}`,
        since: claim.terminalAt,
        ageMs,
        detail: `${claim.kind} claim for terminal conversation ${claim.rootId} remains claimed; allocation key ${allocations}`,
        action: 'run orch sweep',
      },
    ]
  })
  return { conditions, errors: inventory.errors ?? [] }
}
