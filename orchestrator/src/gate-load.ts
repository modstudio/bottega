import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

export type HostLoad = {
  gates: number
  loadavg: number
  ncpu: number
  freeMem: number
}

/** Two concurrent gates is the measured safe operating point (DEV-375). */
export const GATE_CONCURRENCY_LIMIT = 2
export const FREE_MEM_FLOOR_BYTES = 1024 * 1024 * 1024
export const GATE_HOLD_POLL_MS = 250
export const GATE_HOLD_MAX_MS = 10 * 60_000

function gatePidDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCH_GATE_PIDS ?? join(tmpdir(), 'orch-gates')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function countRunningGates(dir = gatePidDir(), selfPid = process.pid): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0) {
      rmSync(path, { force: true })
      continue
    }
    if (pid === selfPid || processAlive(pid)) n++
    else rmSync(path, { force: true })
  }
  return n
}

function registerGatePid(
  pid = process.pid,
  dir = gatePidDir(),
): () => void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, String(pid))
  writeFileSync(path, `${pid}\n`)
  return () => rmSync(path, { force: true })
}

export function measureHostLoad(
  env: NodeJS.ProcessEnv = process.env,
  selfPid = process.pid,
): HostLoad {
  return {
    gates: countRunningGates(gatePidDir(env), selfPid),
    loadavg: loadavg()[0] ?? 0,
    ncpu: Math.max(1, cpus().length),
    freeMem: freemem(),
  }
}

export function shouldHoldShard(load: HostLoad, limit = GATE_CONCURRENCY_LIMIT): boolean {
  return load.gates > limit || load.loadavg >= load.ncpu || load.freeMem < FREE_MEM_FLOOR_BYTES
}

type GateHoldOpts = {
  measure?: () => HostLoad
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  maxMs?: number
  limit?: number
}

export async function withGateSlot<T>(
  run: () => Promise<T>,
  opts: GateHoldOpts = {},
): Promise<T> {
  // Hold BEFORE registering. A waiter with a PID file counts as a running gate
  // to every other starter, so three that start together each saw gates=3,
  // all held, and all entered when the cap expired (review 346). The measure
  // counts only registered runners, so the would-be self is added here to
  // keep shouldHoldShard's meaning: total gates including this one, over the
  // limit, holds.
  const measure = opts.measure ?? measureHostLoad
  const asRunner = (): HostLoad => {
    const load = measure()
    return { ...load, gates: load.gates + 1 }
  }
  const held = await holdForGateCapacity({ ...opts, measure: asRunner })
  if (held.held) {
    console.error(`held ${held.delayedMs}ms for host load `
      + `(gates=${held.load.gates} loadavg=${held.load.loadavg} ncpu=${held.load.ncpu})`)
  }
  const unregister = registerGatePid()
  try {
    return await run()
  } finally {
    unregister()
  }
}

export async function holdForGateCapacity(opts: GateHoldOpts = {}): Promise<{ delayedMs: number; held: boolean; load: HostLoad }> {
  const measure = opts.measure ?? measureHostLoad
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? GATE_HOLD_POLL_MS
  const maxMs = opts.maxMs ?? GATE_HOLD_MAX_MS
  const started = now()
  let delayedMs = 0
  let load = measure()
  if (!shouldHoldShard(load, opts.limit)) return { delayedMs: 0, held: false, load }
  while (now() - started + delayedMs < maxMs) {
    await sleep(pollMs)
    delayedMs += pollMs
    load = measure()
    if (!shouldHoldShard(load, opts.limit)) {
      return { delayedMs, held: true, load }
    }
  }
  return { delayedMs, held: true, load }
}
