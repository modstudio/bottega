// concern: run-process
/**
 * Knows child environment shaping, process inventory, signals, idle-kill, and
 * run events. Must not know routing, contracts, reviews, or transports.
 */

import { createHash } from 'node:crypto'
import type { AGENTS } from '../agent/agent-registry.ts'
import { workerLaunchEnv } from '../agent/worker-launch-env.ts'
import { DB_PATH, db } from '../database/db.ts'
import { depth } from '../dispatch/dispatch-preflight.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { checkpointRun, latestCheckpoint } from './checkpoint.ts'

const ALLOW_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'SSH_AUTH_SOCK',
])
const ALLOW_ENV_PREFIX = /^(LC_|XDG_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CODEX_|QWEN_|ORCH_)/

export function childEnv(
  a: (typeof AGENTS)[string],
  runId?: number,
  runToken?: string,
  extra: Record<string, string> = {},
  includeStore = true,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !(ALLOW_ENV_EXACT.has(k) || ALLOW_ENV_PREFIX.test(k))) continue
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
    ...workerLaunchEnv(a.harness ?? a.name),
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
type ProcessInventory =
  | { ascertainable: true; rows: ProcessRow[] }
  | { ascertainable: false; reason: string }

type TerminateRunProcessesResult =
  | { outcome: 'signaled'; signaled: number[]; acceptableIds: number[] }
  | { outcome: 'identity-mismatch'; acceptableIds: number[] }
  | { outcome: 'unascertainable'; acceptableIds: number[]; reason: string }
  | { outcome: 'no-pid'; acceptableIds: number[] }
  | { outcome: 'gone'; acceptableIds: number[] }

export function commandNamesRun(command: string, acceptableIds: readonly number[]): boolean {
  return acceptableIds.some((id) =>
    new RegExp(`(?:^|[/\\s])exec\\.ts\\s+${id}(?:\\s|$)`).test(command),
  )
}

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

const MAX_FAILOVER_CONVERSATIONS = 100

/** Run ids whose conversations can share the stopped run's coordinator process. */
export function acceptableRunProcessIds(id: number): number[] {
  const member = db().query('SELECT id, parent_run_id FROM run WHERE id=?').get(id) as {
    id: number
    parent_run_id: number | null
  } | null
  if (!member) throw new Error(`no run ${id}`)

  const pending = [member.parent_run_id ?? member.id]
  const roots = new Set<number>()
  const acceptable = new Set<number>()
  while (pending.length) {
    if (roots.size >= MAX_FAILOVER_CONVERSATIONS) {
      throw new Error(`run ${id} automatic failover chain exceeds ${MAX_FAILOVER_CONVERSATIONS}`)
    }
    const rootId = pending.shift()!
    if (roots.has(rootId)) throw new Error(`run ${id} has an automatic failover cycle at ${rootId}`)
    roots.add(rootId)
    const conversation = db()
      .query('SELECT id FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
      .all(rootId, rootId) as { id: number }[]
    for (const row of conversation) acceptable.add(row.id)
    const predecessors = db()
      .query(
        `SELECT prior.id, prior.parent_run_id FROM run successor
         JOIN run prior ON prior.id=successor.retry_of
         WHERE successor.automatic_failover=1
           AND (successor.id=? OR successor.parent_run_id=?)
         ORDER BY prior.id`,
      )
      .all(rootId, rootId) as { id: number; parent_run_id: number | null }[]
    for (const predecessor of predecessors) {
      const predecessorRoot = predecessor.parent_run_id ?? predecessor.id
      if (roots.has(predecessorRoot) || pending.includes(predecessorRoot)) {
        throw new Error(`run ${id} has an automatic failover cycle at ${predecessorRoot}`)
      }
      pending.push(predecessorRoot)
    }
  }
  return [...acceptable].sort((a, b) => a - b)
}

function verifiedProcessTree(
  table: ProcessRow[],
  acceptableIds: readonly number[],
  rootPid: number,
  exclude: number[] = [],
): number[] | null {
  const root = table.find((candidate) => candidate.pid === rootPid)
  if (!root || !commandNamesRun(root.command, acceptableIds)) return null
  const skipped = new Set(exclude)
  const depth = new Map<number, number>([[root.pid, 0]])
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
  return [...depth.entries()]
    .filter(([pid]) => !skipped.has(pid))
    .sort((a, b) => b[1] - a[1])
    .map(([pid]) => pid)
}

export function terminateRunProcesses(
  id: number,
  exclude: number[] = [],
): TerminateRunProcessesResult {
  const row = db().query('SELECT pid, agent_pid FROM run WHERE id=?').get(id) as {
    pid: number | null
    agent_pid: number | null
  } | null
  if (!row) throw new Error(`no run ${id}`)
  if (!row.pid) return { outcome: 'no-pid', acceptableIds: [] }
  const acceptableIds = acceptableRunProcessIds(id)
  const inventory = processTable()
  if (!inventory.ascertainable) {
    console.error(`orch: ${inventory.reason}; nothing signaled`)
    return { outcome: 'unascertainable', acceptableIds, reason: inventory.reason }
  }
  if (!inventory.rows.some((candidate) => candidate.pid === row.pid)) {
    return { outcome: 'gone', acceptableIds }
  }
  // A stop command is itself a descendant of the coordinator it is stopping.
  // If the reaper signals itself, it can exit before reaching a sibling vendor
  // process and leave the caller waiting on that vendor forever.
  const pids = verifiedProcessTree(inventory.rows, acceptableIds, row.pid, [
    ...exclude,
    process.pid,
  ])
  if (pids === null) {
    console.error(
      `orch: run ${id} pid ${row.pid} identity could not be confirmed; nothing signaled`,
    )
    return { outcome: 'identity-mismatch', acceptableIds }
  }
  const signaled: number[] = []
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      signaled.push(pid)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
  }
  return signaled.length
    ? { outcome: 'signaled', signaled, acceptableIds }
    : { outcome: 'gone', acceptableIds }
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
