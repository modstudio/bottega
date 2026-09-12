/**
 * Idle kill: the action half of DEV-374's idle detector.
 *
 * Two timeouts, composed, not one. The wall stays. This is the second, shorter
 * no-activity bound. Jenkins ships both; Travis runs a 10-minute no-output
 * timeout beside its overall cap. We do the same shape, with a stricter idle
 * test (silence AND no CPU) and a failure kind that is not routing evidence.
 */
import { pidAlive } from './process-liveness.ts'
import { idleMsSince } from './events.ts'
import { clock } from './clock.ts'

/**
 * Default 15 minutes. Measured 2026-09-08 against the live store's completed
 * runs that have event logs (90 runs, ids 2874–2997, 17_815 inter-event gaps):
 *
 *   all gaps     p99=1.14m  p99.9=3.24m  max=10.39m (run 2874, fix, ok)
 *   per-run max  p95=5.37m  p99=8.62m
 *   gaps ≥ 5m: 6   ≥ 10m: 1   ≥ 15m: 0
 *
 * Bazel’s method is "as tight as you can without incurring flakiness". 15m is
 * above every observed succeeding gap; 12m would sit 1.6m over the max and is
 * too close to flake a run like 2874. The warn label stays at 5m — it is not
 * this kill.
 */
export const DEFAULT_IDLE_KILL_MS = 15 * 60_000
/**
 * Default idle bound for every job that is not known to be entirely CPU-local.
 * 30m is twice the measured 15m gap bound. The CPU sample cannot see waits
 * outside the vendor tree, so this generous default is the safe one; the short
 * bound is the exception.
 */
export const DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS = 30 * 60_000
export const DEFAULT_IDLE_GRACE_MS = 5_000
export const DEFAULT_IDLE_KILL_CONFIRM_MS = 5_000
/** ps %cpu of a sleeping process is 0.0; a busy loop is ~100. 1% is scheduler noise, not work. */
export const CPU_IDLE_PERCENT = 1

export function idleKillMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_IDLE_KILL_MS
  if (raw === undefined || raw === '') return DEFAULT_IDLE_KILL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_KILL_MS
}

export function idlePollMs(thresholdMs = idleKillMs()): number {
  return Math.max(50, Math.min(1_000, Math.floor(thresholdMs / 5)))
}

export type ProcessSample = {
  pid: number
  ppid: number
  pgid: number
  cpu: number
  state: string
}

export function parsePsTable(text: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 5) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const pgid = Number(parts[2])
    const cpu = Number(parts[3])
    const state = parts[4] ?? ''
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isInteger(ppid) || ppid < 0) continue
    if (!Number.isInteger(pgid) || pgid <= 0) continue
    if (!Number.isFinite(cpu)) continue
    samples.push({ pid, ppid, pgid, cpu, state })
  }
  return samples
}

/** Test-only override so idle detection does not depend on `ps`. */
let testProcessSampler: (() => ProcessSample[]) | null = null

export function installTestProcessSampler(sampler: (() => ProcessSample[]) | null): void {
  testProcessSampler = sampler
}

export function sampleProcesses(): ProcessSample[] {
  if (testProcessSampler) return testProcessSampler()
  try {
    const p = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,pgid=,%cpu=,state='], {
      stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) return []
    return parsePsTable(p.stdout.toString())
  } catch {
    // Bun.spawnSync throws EPERM rather than returning non-zero. An
    // unobservable process table must read as not idle.
    return []
  }
}

export function descendantPids(root: number, samples: ProcessSample[]): number[] {
  const children = new Map<number, number[]>()
  for (const row of samples) {
    const list = children.get(row.ppid) ?? []
    list.push(row.pid)
    children.set(row.ppid, list)
  }
  const out: number[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

/**
 * CPU sample coverage: the vendor pid and its descendants only. That is
 * work inside the vendor process tree, and nothing else. A worker blocked
 * on local-stack, the docker daemon, a lock, or a slow network call reads
 * 0% here because those processes are not descendants. Silence-plus-CPU
 * therefore does not protect an external wait, so the idle bound defaults
 * to the longer one for every job; only a job known to be entirely CPU-local
 * may use the short measured bound.
 */
export function processGroupCpuPercent(pid: number, samples: ProcessSample[]): number | null {
  if (pid <= 0) return null
  const pids = new Set(descendantPids(pid, samples))
  if (!pids.size) return null
  let total = 0
  let seen = false
  for (const row of samples) {
    if (!pids.has(row.pid)) continue
    total += row.cpu
    seen = true
  }
  return seen ? total : null
}

export function isWorkerCpuIdle(pid: number, samples = sampleProcesses()): boolean {
  const cpu = processGroupCpuPercent(pid, samples)
  return cpu !== null && cpu < CPU_IDLE_PERCENT
}

/** Linux D-state and macOS U-state are the same limit: SIGKILL will not land until the syscall returns. */
export function isUninterruptible(state: string): boolean {
  return /[DU]/.test(state)
}

export function groupHasUninterruptible(pid: number, samples: ProcessSample[]): boolean {
  const pids = new Set(descendantPids(pid, samples))
  return samples.some((row) => pids.has(row.pid) && isUninterruptible(row.state))
}

/**
 * Group-kill only when our own pgid is known and the target differs.
 * Unknown selfPgid used to take `pgid !== null`, which is the coordinator's
 * session on a detached `orch do` (setsid: coordinator pgid equals its pid,
 * and the vendor inherits it). pgid 0 and 1 are rejected outright: 0 is not a
 * process group, and kill(-1) is every process the user can signal.
 */
export function isGroupKillablePgid(pgid: number | null | undefined, selfPgid: number | null): boolean {
  if (pgid == null || pgid <= 1) return false
  if (selfPgid == null) return false
  return pgid !== selfPgid
}

export type TerminateDeps = {
  kill: (pid: number, signal: NodeJS.Signals | number) => void
  alive: (pid: number) => boolean
  sample: () => ProcessSample[]
  selfPgid: () => number | null
  wait: (ms: number) => Promise<void>
}
export type TerminateResult = {
  exited: boolean
  unkillable: boolean
  reason: string | null
  pgid: number | null
  pids: number[]
}
const defaultDeps: TerminateDeps = {
  kill(pid, signal) {
    try { process.kill(pid, signal) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
  },
  alive: pidAlive,
  sample: sampleProcesses,
  selfPgid() {
    const mine = sampleProcesses().find((row) => row.pid === process.pid)
    return mine?.pgid ?? null
  },
  wait: (ms) => new Promise((resolve) => clock().setTimeout(resolve, ms)),
}

function signalTree(
  pid: number, signal: NodeJS.Signals | number, deps: TerminateDeps, samples: ProcessSample[], skipRoot = false,
): number | null {
  const self = samples.find((row) => row.pid === pid)
  const pgid = self?.pgid ?? null
  const selfPgid = deps.selfPgid()
  // Signal the process group, not the child. The named #1 cause of lost work
  // is signalling only the direct child when it is a shell or wrapper that
  // does not forward signals: the real worker never sees SIGTERM, rides out
  // the grace period, and is SIGKILLed with no cleanup.
  // Unknown coordinator pgid means walk descendants — never group-kill on an
  // unproven assumption.
  if (isGroupKillablePgid(pgid, selfPgid) && pgid != null) {
    deps.kill(-pgid, signal)
    return pgid
  }
  for (const child of descendantPids(pid, samples)) if (!skipRoot || child !== pid) deps.kill(child, signal)
  return null
}

function pidsSharingPgid(pgid: number | null | undefined, samples: ProcessSample[]): number[] {
  if (pgid == null || pgid <= 1) return []
  return samples.filter((row) => row.pgid === pgid).map((row) => row.pid)
}

/**
 * Re-sample, do not trust the T0 census. A grandchild born after the first
 * sample, then reparented when the wrapper died, is invisible to
 * descendantPids(root) and to a tracked set frozen at T0. Union current
 * descendants of every known pid with anyone still in the vendor pgid.
 */
function rememberTree(
  root: number, tracked: Set<number>, samples: ProcessSample[], pgid?: number | null,
): void {
  const seeds = new Set<number>([root, ...tracked, ...pidsSharingPgid(pgid, samples)])
  for (const seed of seeds) {
    for (const pid of descendantPids(seed, samples)) tracked.add(pid)
  }
  for (const pid of pidsSharingPgid(pgid, samples)) tracked.add(pid)
}

function liveTreePids(
  root: number, tracked: Set<number>, deps: TerminateDeps, pgid: number | null,
): number[] {
  const samples = deps.sample()
  rememberTree(root, tracked, samples, pgid)
  return [...tracked].filter((pid) => pid > 1 && deps.alive(pid))
}

/** Wait on the whole tree, not the root. A wrapper that exits is not the tree dead. */
async function waitUntilDead(
  root: number, tracked: Set<number>, budgetMs: number, deps: TerminateDeps, pgid: number | null,
): Promise<boolean> {
  const started = clock().now()
  while (clock().now() - started < budgetMs) {
    if (liveTreePids(root, tracked, deps, pgid).length === 0) return true
    const remaining = budgetMs - (clock().now() - started)
    if (remaining <= 0) break
    await deps.wait(Math.min(50, remaining))
  }
  return liveTreePids(root, tracked, deps, pgid).length === 0
}

function signalSurvivors(
  tracked: Iterable<number>, signal: NodeJS.Signals | number, deps: TerminateDeps, excluded?: number,
): void {
  for (const pid of tracked) {
    if (pid > 1 && pid !== excluded && deps.alive(pid)) deps.kill(pid, signal)
  }
}

/**
 * SIGTERM the process group, wait the grace period and confirm exit, then
 * SIGKILL. A process in uninterruptible sleep ignores SIGKILL until its
 * syscall returns: bound the attempt and return unkillable rather than
 * looping.
 */
export async function terminateProcessGroup(
  pid: number,
  opts: {
    graceMs?: number
    killConfirmMs?: number
    deps?: Partial<TerminateDeps>
    direct?: { kill(signal?: NodeJS.Signals | number): boolean | void }
  } = {},
): Promise<TerminateResult> {
  if (pid <= 0 || pid === process.pid) {
    return { exited: true, unkillable: false, reason: null, pgid: null, pids: [] }
  }
  const deps: TerminateDeps = { ...defaultDeps, ...opts.deps }
  const graceMs = opts.graceMs ?? DEFAULT_IDLE_GRACE_MS
  const killConfirmMs = opts.killConfirmMs ?? DEFAULT_IDLE_KILL_CONFIRM_MS
  const tracked = new Set<number>([pid])
  const first = deps.sample()
  const vendorPgid = first.find((row) => row.pid === pid)?.pgid ?? null
  const selfPgid = deps.selfPgid()
  // The caller's own process group is never a vendor tree. Refuse it before
  // group membership enters survivor tracking, which can signal tracked pids
  // directly even when signalTree correctly declines kill(-pgid).
  const trackedPgid = vendorPgid !== null && vendorPgid === selfPgid ? null : vendorPgid
  rememberTree(pid, tracked, first, trackedPgid)
  const groupPgid = signalTree(pid, 'SIGTERM', deps, first, Boolean(opts.direct))
  opts.direct?.kill('SIGTERM') // execa owns the direct child's escalation.
  const pgid = groupPgid ?? trackedPgid
  if (await waitUntilDead(pid, tracked, graceMs, deps, pgid)) {
    return { exited: true, unkillable: false, reason: null, pgid, pids: [...tracked] }
  }
  // Re-sample before SIGKILL. The T0 census cannot see a grandchild born
  // after the first sample, and descendantPids(root) cannot see one that
  // reparented once the wrapper died.
  const beforeKill = deps.sample()
  rememberTree(pid, tracked, beforeKill, pgid)
  signalTree(pid, 'SIGKILL', deps, beforeKill, Boolean(opts.direct))
  signalSurvivors(tracked, 'SIGKILL', deps, opts.direct ? pid : undefined)
  if (await waitUntilDead(pid, tracked, killConfirmMs, deps, pgid)) {
    return { exited: true, unkillable: false, reason: null, pgid, pids: [...tracked] }
  }
  const after = deps.sample()
  const dState = groupHasUninterruptible(pid, after) ||
    [...tracked].some((child) => {
      const row = after.find((sample) => sample.pid === child)
      return row ? isUninterruptible(row.state) : false
    })
  return {
    exited: false,
    unkillable: true,
    reason: dState
      ? 'process did not exit after SIGKILL (D-state); needs a human'
      : 'process did not exit after SIGKILL; needs a human',
    pgid,
    pids: [...tracked],
  }
}

export function idlePastThreshold(
  lastEventAt: string | null | undefined,
  startedAt: string,
  now = Date.now(),
  thresholdMs = idleKillMs(),
): boolean {
  const since = idleMsSince(lastEventAt, startedAt, now)
  return since !== null && since >= thresholdMs
}

export function formatIdleKillError(opts: {
  idleMs: number
  reclaimedMs: number
  boundMs: number
  unkillable?: boolean
  unkillableReason?: string | null
}): string {
  const idleM = Math.max(0, opts.idleMs / 60_000)
  const reclaimedM = Math.max(0, opts.reclaimedMs / 60_000)
  const wallM = Math.max(0, opts.boundMs / 60_000)
  const idleLabel = idleM >= 1 ? `${Math.floor(idleM)}m` : `${Math.round(opts.idleMs / 1000)}s`
  const reclaimedLabel = reclaimedM >= 1 ? `${reclaimedM.toFixed(1)}m` : `${Math.round(opts.reclaimedMs / 1000)}s`
  const wallLabel = wallM >= 1 ? `${Math.round(wallM)}m` : `${Math.round(opts.boundMs / 1000)}s`
  const base = `idle-killed after ${idleLabel} with no CPU; reclaimed ${reclaimedLabel} of ${wallLabel} wall ` +
    `[reclaimed_ms=${Math.round(opts.reclaimedMs)} wall_ms=${Math.round(opts.boundMs)}]`
  return opts.unkillable && opts.unkillableReason ? `${base}; ${opts.unkillableReason}` : base
}

export function parseIdleReclaimedMs(error: string | null | undefined): number | null {
  if (!error) return null
  const match = error.match(/reclaimed_ms=(\d+)/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

export type IdleKillDecision = {
  kill: boolean
  idleMs: number | null
  reason: string | null
}

/**
 * Preserving work is the purpose of idle kill. If the final checkpoint
 * failed and nothing earlier exists, do not kill: leave the worker for
 * the wall. Killing would discard in-memory buffers with work_preserved=0.
 */
/**
 * The same tree walk termination uses. A half-terminated wrapper that
 * exited while a child lives still blocks reclaim: removeFor with
 * forceOrchTree would otherwise delete the worktree under a live process.
 */
export function runHasLiveDescendants(
  roots: Array<number | null | undefined>,
  extra: Iterable<number> = [],
  deps: Partial<TerminateDeps> = {},
  pgid?: number | null,
): boolean {
  const resolved: TerminateDeps = { ...defaultDeps, ...deps }
  const samples = resolved.sample()
  const ids = new Set<number>([...extra, ...pidsSharingPgid(pgid, samples)])
  for (const root of [...roots, ...extra]) {
    if (root && root > 1) {
      for (const pid of descendantPids(root, samples)) ids.add(pid)
    }
  }
  return [...ids].some((pid) => pid > 1 && resolved.alive(pid))
}

export function idleKillMayProceed(
  checkpoint: { created: boolean; error: string | null } | null,
  hasPriorCheckpoint: boolean,
): boolean {
  if (checkpoint == null) return true
  if (checkpoint.error && !hasPriorCheckpoint) return false
  return true
}

export function shouldIdleKill(opts: {
  lastEventAt: string | null | undefined
  startedAt: string
  pid: number | null | undefined
  asking: boolean
  openQuestion: boolean
  alreadyTimedOut: boolean
  alreadyIdleKilled: boolean
  now?: number
  thresholdMs?: number
  samples?: ProcessSample[]
}): IdleKillDecision {
  if (opts.alreadyTimedOut || opts.alreadyIdleKilled) {
    return { kill: false, idleMs: null, reason: 'another terminator owns this run' }
  }
  if (opts.asking || opts.openQuestion) {
    return { kill: false, idleMs: null, reason: 'waiting on a ruling' }
  }
  const pid = opts.pid ?? 0
  if (pid <= 0) return { kill: false, idleMs: null, reason: 'no vendor pid' }
  const now = opts.now ?? Date.now()
  const thresholdMs = opts.thresholdMs ?? idleKillMs()
  const idleMs = idleMsSince(opts.lastEventAt, opts.startedAt, now)
  if (idleMs === null || idleMs < thresholdMs) {
    return { kill: false, idleMs, reason: 'silence below threshold' }
  }
  const samples = opts.samples ?? sampleProcesses()
  const cpu = processGroupCpuPercent(pid, samples)
  if (cpu === null) {
    return { kill: false, idleMs, reason: 'process table unobservable' }
  }
  if (cpu >= CPU_IDLE_PERCENT) {
    return { kill: false, idleMs, reason: 'quiet but burning CPU' }
  }
  return { kill: true, idleMs, reason: null }
}
