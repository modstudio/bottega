// concern: run-process
/**
 * Knows child environment shaping, process inventory, signals, idle-kill, and
 * run events. Must not know routing, contracts, reviews, or transports.
 */
import { createHash } from 'node:crypto'
import { AGENTS } from './agents.ts'
import { checkpointRun, latestCheckpoint } from './checkpoint.ts'
import { DB_PATH, db } from './db.ts'
import { depth } from './dispatch-preflight.ts'

const ALLOW_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK',
])
const ALLOW_ENV_PREFIX =
  /^(LC_|XDG_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CODEX_|QWEN_|ORCH_)/

export function childEnv(
  a: (typeof AGENTS)[string], runId?: number, runToken?: string,
  extra: Record<string, string> = {}, includeStore = true,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !(ALLOW_ENV_EXACT.has(k) || ALLOW_ENV_PREFIX.test(k))) continue
    env[k] = v
  }
  env.ORCH_DEPTH = String(depth() + 1)
  if (runId) env.ORCH_RUN_ID = String(runId)
  if (runToken) env.ORCH_RUN_TOKEN = runToken
  if (includeStore) env.ORCH_DB = DB_PATH
  const child = { ...env, ...(a.env?.() ?? {}), ...extra }
  if (!includeStore) delete child.ORCH_DB
  return child
}

export const live = new Set<{ kill(sig?: number | string): void }>()
export type LiveProcess = { kill(sig?: number | string): void }
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

type ProcessRow = { pid: number; ppid: number; pgid: number; command: string }
type ProcessInventory =
  | { ascertainable: true; rows: ProcessRow[] }
  | { ascertainable: false; reason: string }

let testProcessInventory: ProcessInventory | null = null
export function installTestProcessInventory(inventory: ProcessInventory | null): void {
  testProcessInventory = inventory
}

export function processTable(): ProcessInventory {
  if (testProcessInventory) return testProcessInventory
  let p
  try {
    p = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=,command='], {
      stdout: 'pipe', stderr: 'pipe', timeout: 1_000,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `process inventory unavailable: ${String((error as Error).message ?? error)}`,
    }
  }
  if (p.exitCode !== 0) {
    const stderr = p.stderr.length ? `: ${p.stderr.toString().trim()}` : ''
    if (p.exitCode === null && p.signalCode === 'SIGTERM') {
      return { ascertainable: false, reason: `process inventory did not complete inside 1000ms${stderr}` }
    } else if (p.exitCode !== null) {
      return { ascertainable: false, reason: `process inventory failed with exit ${p.exitCode}${stderr}` }
    }
    return {
      ascertainable: false,
      reason: `process inventory ended on signal ${p.signalCode ?? 'unknown'}${stderr}`,
    }
  }
  return {
    ascertainable: true,
    rows: p.stdout.toString().split('\n').flatMap((line): ProcessRow[] => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! }]
        : []
    }),
  }
}

export function verifiedProcessTree(
  table: ProcessRow[], id: number, rootPid: number, exclude: number[] = [],
): number[] {
  const root = table.find((candidate) => candidate.pid === rootPid)
  const identity = new RegExp(`(?:^|[/\\s])exec\\.ts\\s+${id}(?:\\s|$)`)
  if (!root || !identity.test(root.command)) return []
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

export function terminateRunProcesses(id: number, exclude: number[] = []): number[] {
  const row = db().query('SELECT pid, agent_pid FROM run WHERE id=?').get(id) as
    { pid: number | null; agent_pid: number | null } | null
  if (!row) throw new Error(`no run ${id}`)
  if (!row.pid) return []
  const inventory = processTable()
  if (!inventory.ascertainable) {
    console.error(`orch: ${inventory.reason}; nothing signalled`)
    return []
  }
  const pids = verifiedProcessTree(inventory.rows, id, row.pid, [...exclude, process.pid])
  if (!pids.length) {
    if (inventory.rows.some((candidate) => candidate.pid === row.pid)) {
      console.error(`orch: run ${id} pid ${row.pid} identity could not be confirmed; nothing signalled`)
    }
    return []
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
  }
  return pids
}

let signalsBound = false
let terminating = false

export function bindSignals() {
  if (signalsBound) return
  signalsBound = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (terminating) return
      terminating = true
      setTimeout(() => process.exit(130), 5_000)
      for (const p of live) { try { p.kill('SIGTERM') } catch { /* already gone */ } }
      for (const checkpoint of liveCheckpoints.values()) {
        const result = checkpointRun({
          database: db(), runId: checkpoint.runId, worktree: checkpoint.worktree,
          branch: checkpoint.branch, taskKey: checkpoint.taskKey,
          scratchDir: checkpoint.scratchDir,
          guardEnvironment: checkpoint.guardEnvironment, final: true,
        })
        if (result.created || latestCheckpoint(db(), checkpoint.rootId)) {
          db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(checkpoint.runId)
        }
        if (result.error) {
          console.error(`orch: run ${checkpoint.runId} final checkpoint failed: ${result.error}`)
        }
      }
      setTimeout(() => process.exit(130), 250)
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
