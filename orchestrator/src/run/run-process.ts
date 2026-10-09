// concern: run-process
/**
 * Knows child environment shaping, process inventory, signals, idle-kill, and
 * run events. Must not know routing, contracts, reviews, or transports.
 */

import { createHash } from 'node:crypto'
import {
  type PidRecordIdentity,
  pidAlive,
  pidRecordIdentity,
} from '../../../shared/process-identity.ts'
import type { AGENTS } from '../agent/agent-registry.ts'
import { workerHarnessName, workerLaunchEnv } from '../agent/worker-launch-env.ts'
import { DB_PATH, db } from '../database/db.ts'
import { depth } from '../dispatch/dispatch-preflight.ts'
import { DEFAULT_IDLE_GRACE_MS, isGroupKillablePgid, terminateProcessGroup } from '../idle-kill.ts'
import { isForwardedChildEnvName } from '../sandbox/record-connection-env.ts'
import { checkpointRun, latestCheckpoint } from './checkpoint.ts'

export function childEnv(
  a: (typeof AGENTS)[string],
  runId?: number,
  runToken?: string,
  extra: Record<string, string> = {},
  includeStore = true,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !isForwardedChildEnvName(k)) continue
    env[k] = v
  }
  env.ORCH_DEPTH = String(depth() + 1)
  /**
   * Which run is asking, for the ask-server the child may call back into.
   *
   * Set HERE, by the process that spawned the agent, because that is the only
   * party that actually knows. A worker naming its own run id would be guessing,
   * and in a fan-out several are alive at once — so the guess would sometimes
   * attach a question to another worker's run, and the ruling would be delivered
   * to whichever of them happened to be waiting.
   */
  if (runId) env.ORCH_RUN_ID = String(runId)
  // The credential half. The id says which run; this says the caller is
  // actually that run, and the environment of a child process is the one place
  // an unrelated process cannot read it from.
  if (runToken) env.ORCH_RUN_TOKEN = runToken
  /**
   * THE REAL DATABASE, not the one beside whatever checkout the worker is in.
   *
   * The parent has already resolved the one database through ORCH_DB, git's
   * common directory, or the main binary. Passing the absolute result keeps a
   * detached worker on that same file even after its cwd changes to a worktree.
   *
   * Reported by a worker that checked the command before building on it, which
   * is exactly the behavior the contract asks for and exactly how this was
   * found.
   *
   * Residual exposure: the canon accepts that a worktree worker reads the real
   * register.
   */
  if (includeStore) env.ORCH_DB = DB_PATH
  const child = {
    ...env,
    ...(a.env?.() ?? {}),
    ...extra,
    ...workerLaunchEnv(workerHarnessName(a)),
  }
  if (!includeStore) delete child.ORCH_DB
  return child
}
export type LiveProcess = { pid?: number | null; kill(sig?: number | string): void }
export const live = new Set<LiveProcess>()
export type LiveCheckpoint = {
  runId: number
  rootId: number
  worktree: string
  branch: string
  taskKey: string
  scratchDir: string
  guardEnvironment: NodeJS.ProcessEnv
}
export const liveCheckpoints = new Map<LiveProcess, LiveCheckpoint>()
const liveGateTerminators = new Set<() => Promise<void>>()

export function registerLiveGate(terminate: () => Promise<void>): () => void {
  liveGateTerminators.add(terminate)
  return () => liveGateTerminators.delete(terminate)
}

type ProcessRow = { pid: number; ppid: number; pgid: number; command: string }
export type ProcessInventory =
  | { ascertainable: true; rows: ProcessRow[] }
  | { ascertainable: false; reason: string }

export type TerminateRunProcessesResult =
  | { outcome: 'signaled'; signaled: number[] }
  | { outcome: 'identity-mismatch'; pid: number }
  | { outcome: 'no-pid' }
  | { outcome: 'no-vendor' }
  | { outcome: 'gone' }
  | { outcome: 'still-alive'; pid: number; reason: string }

export type RunProcessRecord = {
  pid: number | null
  agentPid: number | null
  agentPgid: number | null
  agentStartTime: string | null
}

export type VerifiedRunProcessTermination = {
  outcome: 'verified'
  rootPid: number
  pids: number[]
  pgid: number | null
  signalGroup: boolean
}

export type RunProcessTerminationPlan =
  | { outcome: 'no-pid' }
  | { outcome: 'no-vendor' }
  | { outcome: 'gone' }
  | { outcome: 'identity-mismatch'; pid: number }
  | VerifiedRunProcessTermination

export function processTable(): ProcessInventory {
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=,command='], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 1_000,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `process inventory unavailable: ${String((error as Error).message ?? error)}`,
    }
  }
  if (p.exitCode !== 0) {
    const stderr = p.stderr!.length ? `: ${p.stderr!.toString().trim()}` : ''
    if (p.exitCode === null && p.signalCode === 'SIGTERM') {
      return {
        ascertainable: false,
        reason: `process inventory did not complete inside 1000ms${stderr}`,
      }
    } else if (p.exitCode !== null) {
      return {
        ascertainable: false,
        reason: `process inventory failed with exit ${p.exitCode}${stderr}`,
      }
    }
    return {
      ascertainable: false,
      reason: `process inventory ended on signal ${p.signalCode ?? 'unknown'}${stderr}`,
    }
  }
  return {
    ascertainable: true,
    rows: p
      .stdout!.toString()
      .split('\n')
      .flatMap((line): ProcessRow[] => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
        return match
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                command: match[4]!,
              },
            ]
          : []
      }),
  }
}

function commandIsRunExecutor(command: string): boolean {
  return /(?:^|[/\s])exec\.ts\s+\d+(?:\s|$)/.test(command)
}

/**
 * Whether this process is running inside an orch worker executor.
 *
 * This guards operator-only actions against confused workers. It is not a
 * security boundary against a same-uid process that detaches itself: that
 * process already has the operator's full user power.
 */
export function isOrchWorkerProcess(
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
  inventory: ProcessInventory = processTable(),
): boolean {
  if (env.ORCH_RUN_ID) return true
  if (!inventory.ascertainable) return false

  const byPid = new Map(inventory.rows.map((row) => [row.pid, row]))
  const seen = new Set<number>()
  let current = byPid.get(pid)
  while (current && !seen.has(current.pid)) {
    seen.add(current.pid)
    const parent = byPid.get(current.ppid)
    if (!parent) return false
    if (commandIsRunExecutor(parent.command)) return true
    current = parent
  }
  return false
}

function vendorLeadsOwnGroup(recorded: RunProcessRecord): boolean {
  return (
    recorded.agentPid != null &&
    recorded.agentPgid != null &&
    recorded.agentPgid === recorded.agentPid
  )
}

function vendorProcessPids(
  table: ProcessRow[],
  vendorPid: number,
  vendorPgid: number | null,
  skipped: Set<number>,
): number[] {
  const includeGroup = vendorPgid != null && vendorPgid > 1 && vendorPgid === vendorPid
  const depth = new Map<number, number>([[vendorPid, 0]])
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of table) {
      const parentDepth = depth.get(candidate.ppid)
      if (parentDepth === undefined || depth.has(candidate.pid)) continue
      depth.set(candidate.pid, parentDepth + 1)
      changed = true
    }
  }
  if (includeGroup) {
    for (const row of table) {
      if (row.pgid === vendorPgid && !depth.has(row.pid)) depth.set(row.pid, 1)
    }
  }
  return [...depth.keys()].filter((pid) => pid > 1 && !skipped.has(pid))
}

function recordedVendorIdentity(
  recorded: RunProcessRecord,
  identity: (
    pid: number | null | undefined,
    recordedStartTime: string | null | undefined,
  ) => PidRecordIdentity,
): PidRecordIdentity {
  if (!recorded.agentPid) return recorded.pid ? 'unknown' : 'dead'
  return identity(recorded.agentPid, recorded.agentStartTime)
}

/** Decide which vendor pids a stop may signal. Coordinator command lines are not identity. */
export function planRunProcessTermination(input: {
  recorded: RunProcessRecord
  vendorIdentity: PidRecordIdentity
  inventory: ProcessInventory
  exclude: readonly number[]
  selfPid: number
  selfPgid?: number | null
}): RunProcessTerminationPlan {
  const { recorded, vendorIdentity, inventory, exclude, selfPid } = input
  if (!recorded.agentPid && !recorded.pid) return { outcome: 'no-pid' }
  if (!recorded.agentPid) return { outcome: 'no-vendor' }
  if (vendorIdentity === 'dead') return { outcome: 'gone' }
  if (vendorIdentity !== 'live') return { outcome: 'identity-mismatch', pid: recorded.agentPid }
  const skipped = new Set<number>(
    [...exclude, selfPid, recorded.pid].filter((pid): pid is number => Boolean(pid && pid > 1)),
  )
  if (skipped.has(recorded.agentPid)) {
    return { outcome: 'identity-mismatch', pid: recorded.agentPid }
  }
  const table = inventory.ascertainable ? inventory.rows : []
  const pids = vendorProcessPids(table, recorded.agentPid, recorded.agentPgid, skipped)
  if (!pids.includes(recorded.agentPid)) pids.push(recorded.agentPid)
  return {
    outcome: 'verified',
    rootPid: recorded.agentPid,
    pids,
    pgid: recorded.agentPgid,
    signalGroup:
      vendorLeadsOwnGroup(recorded) &&
      isGroupKillablePgid(recorded.agentPgid, input.selfPgid ?? null),
  }
}

export type TerminateRunProcessesDeps = {
  inventory?: () => ProcessInventory
  identity?: (
    pid: number | null | undefined,
    recordedStartTime: string | null | undefined,
  ) => PidRecordIdentity
  kill?: (pid: number, signal: NodeJS.Signals | number) => void
  alive?: (pid: number) => boolean
  wait?: (ms: number) => void
  confirmMs?: number
  selfPgid?: () => number | null
}

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals | number) => void,
): void {
  try {
    kill(-pgid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'ESRCH') throw error
  }
}

function firstAlivePid(pids: readonly number[], alive: (pid: number) => boolean): number | null {
  return pids.find((pid) => alive(pid)) ?? null
}

function waitWhileAnyAlive(
  pids: readonly number[],
  alive: (pid: number) => boolean,
  wait: (ms: number) => void,
  deadline: number,
): number | null {
  let remaining = firstAlivePid(pids, alive)
  while (remaining != null && Date.now() < deadline) {
    wait(Math.min(50, deadline - Date.now()))
    remaining = firstAlivePid(pids, alive)
  }
  return remaining
}

function reapVerifiedVendor(
  plan: VerifiedRunProcessTermination,
  deps: TerminateRunProcessesDeps,
): TerminateRunProcessesResult {
  const kill = deps.kill ?? defaultKill
  const alive = deps.alive ?? ((pid: number) => pidAlive(pid))
  const wait = deps.wait ?? waitMs
  const confirmMs = deps.confirmMs ?? 0
  if (plan.signalGroup && plan.pgid != null) signalProcessGroup(plan.pgid, 'SIGTERM', kill)
  for (const pid of plan.pids) kill(pid, 'SIGTERM')
  if (confirmMs <= 0) return { outcome: 'signaled', signaled: plan.pids }
  if (waitWhileAnyAlive(plan.pids, alive, wait, Date.now() + confirmMs) == null) {
    return { outcome: 'signaled', signaled: plan.pids }
  }
  if (plan.signalGroup && plan.pgid != null) signalProcessGroup(plan.pgid, 'SIGKILL', kill)
  for (const pid of plan.pids) {
    if (alive(pid)) kill(pid, 'SIGKILL')
  }
  const remaining = waitWhileAnyAlive(plan.pids, alive, wait, Date.now() + confirmMs)
  if (remaining == null) return { outcome: 'signaled', signaled: plan.pids }
  return {
    outcome: 'still-alive',
    pid: remaining,
    reason: 'process did not exit after SIGKILL',
  }
}

function readRunProcessRecord(id: number): RunProcessRecord {
  const row = db()
    .query('SELECT pid, agent_pid, agent_pgid, agent_start_time FROM run WHERE id=?')
    .get(id) as {
    pid: number | null
    agent_pid: number | null
    agent_pgid: number | null
    agent_start_time: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)
  return {
    pid: row.pid,
    agentPid: row.agent_pid,
    agentPgid: row.agent_pgid,
    agentStartTime: row.agent_start_time,
  }
}

function selfPgidFromInventory(inventory: ProcessInventory, pid: number): number | null {
  if (!inventory.ascertainable) return null
  return inventory.rows.find((item) => item.pid === pid)?.pgid ?? null
}

export function planRecordedRunTermination(
  id: number,
  exclude: number[] = [],
  deps: TerminateRunProcessesDeps = {},
): RunProcessTerminationPlan {
  const recorded = readRunProcessRecord(id)
  const inventory = (deps.inventory ?? processTable)()
  const selfPgid = deps.selfPgid?.() ?? selfPgidFromInventory(inventory, process.pid)
  return planRunProcessTermination({
    recorded,
    vendorIdentity: recordedVendorIdentity(recorded, deps.identity ?? pidRecordIdentity),
    inventory,
    exclude,
    selfPid: process.pid,
    selfPgid,
  })
}

export function confirmRunProcessTermination(
  plan: VerifiedRunProcessTermination,
  deps: TerminateRunProcessesDeps = {},
): TerminateRunProcessesResult {
  return reapVerifiedVendor(plan, {
    ...deps,
    confirmMs: deps.confirmMs ?? DEFAULT_IDLE_GRACE_MS,
  })
}

export function terminateRunProcesses(
  id: number,
  exclude: number[] = [],
  deps: TerminateRunProcessesDeps = {},
): TerminateRunProcessesResult {
  const plan = planRecordedRunTermination(id, exclude, deps)
  if (plan.outcome !== 'verified') return plan
  return reapVerifiedVendor(plan, deps)
}

let signalsBound = false
let terminating = false

export function bindSignals() {
  if (signalsBound) return
  signalsBound = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      if (terminating) return
      terminating = true
      setTimeout(() => process.exit(130), 5_000)
      for (const p of live) void terminateProcessGroup(p.pid ?? 0, { direct: p })
      await Promise.all([...liveGateTerminators].map((terminate) => terminate()))
      for (const checkpoint of liveCheckpoints.values()) {
        const result = checkpointRun({
          database: db(),
          runId: checkpoint.runId,
          worktree: checkpoint.worktree,
          branch: checkpoint.branch,
          taskKey: checkpoint.taskKey,
          scratchDir: checkpoint.scratchDir,
          guardEnvironment: checkpoint.guardEnvironment,
          final: true,
        })
        if (result.created || latestCheckpoint(db(), checkpoint.rootId)) {
          db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(checkpoint.runId)
        }
        if (result.error) {
          console.error(`orch: run ${checkpoint.runId} final checkpoint failed: ${result.error}`)
        }
      }
      process.exit(130)
    })
  }
}

export const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export function errorTail(blob: string, limit = 2000): string {
  const t = blob.trim()
  if (t.length <= limit) return t
  const head = Math.floor(limit / 4)
  const tail = limit - head
  return `${t.slice(0, head)}\n… [${t.length - limit} characters omitted] …\n${t.slice(t.length - tail)}`
}
