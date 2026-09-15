// concern: monitor-conditions
/** Owns monitor condition detection and the row queries and helpers those detectors share with composition and notice revalidation. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, liveRuns } from './db.ts'
import { idleLabel, idleMsSince, idleWarnMs } from './events.ts'
import { UNSCORED_WHERE } from './evidence-query.ts'
import { targetGitEnvironment } from './git-environment.ts'
import { runHasLiveDescendants } from './idle-kill.ts'
import type { MonitorCondition } from './monitor-types.ts'
import { pidAlive } from './process-liveness.ts'
import { pidRecordIdentity } from './project-lock.ts'
import { projects } from './projects.ts'
import {
  refGuardInventory,
  retainedRefInventory,
  worktreeDatabaseInventory,
} from './resource-inventory.ts'

const HUB = new URL('../../bin/hub', import.meta.url).pathname

const ASKING_RUN_WHERE = `status='asking'
   AND NOT EXISTS (
     SELECT 1 FROM question q WHERE q.run_id = run.id AND q.answered_at IS NULL
   )`

type AddressedRun = { id: number; started_at: string; session_id: string | null }

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
        AND close_out_outcome IN ('held','failed')`,
    )
    .all() as TerminalCloseOutRun[]
}

export function unscoredRuns(database = db()): AddressedRun[] {
  return database
    .query(
      `SELECT r.id, r.started_at, r.session_id
       FROM run r LEFT JOIN score s ON s.run_id=r.id WHERE ${UNSCORED_WHERE}`,
    )
    .all() as AddressedRun[]
}

export const age = (since: string | null, clock: number) => {
  if (!since) return null
  const at = Date.parse(since)
  return Number.isFinite(at) ? Math.max(0, clock - at) : null
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
