import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, freemem, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

export type HostLoad = {
  gates: number
  loadavg: number
  ncpu: number
  freeMem: number
}

/** Two concurrent gates is the measured safe operating point. */
export const GATE_CONCURRENCY_LIMIT = 2
const FREE_MEM_FLOOR_BYTES = 1024 * 1024 * 1024
const GATE_HOLD_POLL_MS = 250
const GATE_HOLD_MAX_MS = 10 * 60_000
const MEBIBYTE_BYTES = 1024 * 1024

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

function registerGatePid(pid = process.pid, dir = gatePidDir()): () => void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, String(pid))
  writeFileSync(path, `${pid}\n`)
  return () => rmSync(path, { force: true })
}

function measureHostLoad(env: NodeJS.ProcessEnv = process.env, selfPid = process.pid): HostLoad {
  return {
    gates: countRunningGates(gatePidDir(env), selfPid),
    loadavg: loadavg()[0] ?? 0,
    ncpu: Math.max(1, cpus().length),
    freeMem: freemem(),
  }
}

export type GateHoldCondition = 'gates' | 'load' | 'memory'
const GATE_HOLD_CONDITION_ORDER: GateHoldCondition[] = ['gates', 'load', 'memory']

export function gateHoldConditions(
  load: HostLoad,
  limit = GATE_CONCURRENCY_LIMIT,
): GateHoldCondition[] {
  const conditions: GateHoldCondition[] = []
  if (load.gates > limit) conditions.push('gates')
  if (load.loadavg >= load.ncpu) conditions.push('load')
  if (load.freeMem < FREE_MEM_FLOOR_BYTES) conditions.push('memory')
  return conditions
}

export function shouldHoldShard(load: HostLoad, limit = GATE_CONCURRENCY_LIMIT): boolean {
  return gateHoldConditions(load, limit).length > 0
}

type GateHoldOpts = {
  env?: NodeJS.ProcessEnv
  measure?: () => HostLoad
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  maxMs?: number
  limit?: number
}

export async function withGateSlot<T>(run: () => Promise<T>, opts: GateHoldOpts = {}): Promise<T> {
  // Hold BEFORE registering. A waiter with a PID file counts as a running gate
  // to every other starter, so three that start together each saw gates=3,
  // all held, and all entered when the cap expired (review 346). The measure
  // counts only registered runners, so the would-be self is added here to
  // keep shouldHoldShard's meaning: total gates including this one, over the
  // limit, holds.
  const env = opts.env ?? process.env
  if (!env.CI) {
    const measure = opts.measure ?? (() => measureHostLoad(env))
    const asRunner = (): HostLoad => {
      const load = measure()
      return { ...load, gates: load.gates + 1 }
    }
    const held = await holdForGateCapacity({ ...opts, measure: asRunner })
    if (held.held) {
      console.error(
        `held ${held.delayedMs}ms for host load ` +
          `(gates=${held.load.gates} loadavg=${held.load.loadavg} ncpu=${held.load.ncpu} ` +
          `free_mb=${Math.floor(held.load.freeMem / MEBIBYTE_BYTES)} ` +
          `floor_mb=${Math.floor(FREE_MEM_FLOOR_BYTES / MEBIBYTE_BYTES)} ` +
          `held_on=${held.heldOn.join('+')})`,
      )
      if (held.exhausted) {
        console.error(
          'admitted over the load threshold after the maximum hold; a per-test timeout in this run is suspect, rerun before treating it as a failure',
        )
      }
    }
  }
  const unregister = registerGatePid(process.pid, gatePidDir(env))
  try {
    return await run()
  } finally {
    unregister()
  }
}

export async function holdForGateCapacity(opts: GateHoldOpts = {}): Promise<{
  delayedMs: number
  held: boolean
  exhausted: boolean
  load: HostLoad
  heldOn: GateHoldCondition[]
}> {
  const measure = opts.measure ?? measureHostLoad
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? GATE_HOLD_POLL_MS
  const maxMs = opts.maxMs ?? GATE_HOLD_MAX_MS
  const started = now()
  let delayedMs = 0
  let load = measure()
  const seenConditions = new Set(gateHoldConditions(load, opts.limit))
  const heldOn = () =>
    GATE_HOLD_CONDITION_ORDER.filter((condition) => seenConditions.has(condition))
  if (seenConditions.size === 0) {
    return { delayedMs: 0, held: false, exhausted: false, load, heldOn: [] }
  }
  while (delayedMs < maxMs) {
    await sleep(Math.min(pollMs, maxMs - delayedMs))
    delayedMs = now() - started
    load = measure()
    const conditions = gateHoldConditions(load, opts.limit)
    for (const condition of conditions) seenConditions.add(condition)
    if (conditions.length === 0) {
      return { delayedMs, held: true, exhausted: false, load, heldOn: heldOn() }
    }
  }
  return { delayedMs, held: true, exhausted: true, load, heldOn: heldOn() }
}
