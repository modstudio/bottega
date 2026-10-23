import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { cpus, freemem, loadavg } from 'node:os'
import { join } from 'node:path'
import { resolveStatePaths } from '../../shared/state-directory.ts'

export type HostLoad = {
  gates: number
  loadavg: number
  ncpu: number
  freeMem: number
  pressure: MemoryPressure
  swapUsed: number
  swapTotal: number
  recentAdmissions: number
  waitingRequests: number
  oldestWaitMs: number
}
export type MemoryPressure = 'normal' | 'warning' | 'critical' | 'unknown'
export type HostHoldCondition = 'gates' | 'load' | 'memory' | 'queue'
export type GateWaitState = {
  delayedMs: number
  load: HostLoad
  heldOn: HostHoldCondition[]
}
export type HostSlotDecision = { admit: boolean; heldOn: HostHoldCondition[] }
export type HostCapacityDecision = HostSlotDecision & { boundReached: boolean }

/** Two concurrent gates is the measured safe operating point. */
const GATE_CONCURRENCY_LIMIT = 2
/** Reservations cover the one-minute interval before admitted work appears in load average. */
export const HOST_LOAD_RESERVATION_MS = 60_000
export const HOST_SLOT_HELD_ENV = 'BOTTEGA_HOST_SLOT_HELD'
const FREE_MEM_FLOOR_BYTES = 1024 * 1024 * 1024
const GATE_HOLD_POLL_MS = 250
const MEMORY_PRESSURE_READ_TIMEOUT_MS = 100
const MEBIBYTE_BYTES = 1024 * 1024
const GATE_HOLD_CONDITION_ORDER: HostHoldCondition[] = ['gates', 'load', 'memory', 'queue']

function gatePidDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStatePaths(env).orchestratorDirectory, 'host-slots')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Lease = { pid: number; admittedAt: number }

const LEASE_NAME = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function reportUnsafeSlotEntry(path: string, kind: string): void {
  console.error(`left unsafe host capacity entry untouched (${kind}): ${path}`)
}

function safeDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) return true
    reportUnsafeSlotEntry(path, stat.isSymbolicLink() ? 'symlink' : 'not a directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      reportUnsafeSlotEntry(path, (error as NodeJS.ErrnoException).code ?? 'unreadable')
  }
  return false
}

function ensureSafeDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
  if (!safeDirectory(path)) throw new Error(`unsafe host capacity directory: ${path}`)
}

function readRegularFile(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      reportUnsafeSlotEntry(path, (error as NodeJS.ErrnoException).code ?? 'unreadable')
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) {
      reportUnsafeSlotEntry(path, 'not a regular file')
      return null
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function removeRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      reportUnsafeSlotEntry(path, stat.isSymbolicLink() ? 'symlink' : 'not a regular file')
      return false
    }
    unlinkSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      reportUnsafeSlotEntry(path, (error as NodeJS.ErrnoException).code ?? 'unremovable')
    return false
  }
}

function readLease(path: string): Lease | null {
  try {
    const contents = readRegularFile(path)
    if (contents === null) return null
    const value = JSON.parse(contents) as Partial<Lease>
    if (Number.isInteger(value.pid) && Number(value.pid) > 0 && Number.isFinite(value.admittedAt))
      return value as Lease
  } catch {}
  return null
}

function liveLeases(dir: string, selfPid: number): Lease[] {
  if (!safeDirectory(dir)) return []
  const leases: Lease[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'waiters' || name === 'acquire.lock') continue
    const path = join(dir, name)
    if (!LEASE_NAME.test(name)) {
      reportUnsafeSlotEntry(path, 'unrecognized name')
      continue
    }
    const lease = readLease(path)
    if (!lease) {
      removeRegularFile(path)
      continue
    }
    if (lease.pid === selfPid || processAlive(lease.pid)) leases.push(lease)
    else removeRegularFile(path)
  }
  return leases
}

export function measureHostWaiters(
  env: NodeJS.ProcessEnv = process.env,
  selfPid = process.pid,
  now = Date.now(),
) {
  const dir = gatePidDir(env)
  const waitDir = join(dir, 'waiters')
  if (!safeDirectory(waitDir)) return { waitingRequests: 0, oldestWaitMs: 0 }
  const starts: number[] = []
  for (const name of readdirSync(waitDir)) {
    const path = join(waitDir, name)
    if (!LEASE_NAME.test(name)) {
      reportUnsafeSlotEntry(path, 'unrecognized name')
      continue
    }
    const lease = readLease(path)
    if (!lease || (lease.pid !== selfPid && !processAlive(lease.pid))) {
      removeRegularFile(path)
      continue
    }
    starts.push(lease.admittedAt)
  }
  return {
    waitingRequests: starts.length,
    oldestWaitMs: starts.length ? Math.max(0, now - Math.min(...starts)) : 0,
  }
}

function registerLease(dir: string, subdir: string | null, admittedAt: number): () => void {
  const target = subdir ? join(dir, subdir) : dir
  ensureSafeDirectory(dir)
  if (subdir) ensureSafeDirectory(target)
  const path = join(target, `${process.pid}-${randomUUID()}`)
  writeFileSync(path, JSON.stringify({ pid: process.pid, admittedAt }))
  return () => {
    removeRegularFile(path)
  }
}

export function parseMacOSMemoryPressure(output: string | undefined): MemoryPressure {
  switch (output?.trim()) {
    case '1':
      return 'normal'
    case '2':
      return 'warning'
    case '4':
      return 'critical'
    default:
      return 'unknown'
  }
}

function readMemoryPressure(platform: NodeJS.Platform): MemoryPressure {
  if (platform !== 'darwin') return 'unknown'
  try {
    const result = Bun.spawnSync(
      ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'],
      {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: MEMORY_PRESSURE_READ_TIMEOUT_MS,
      },
    )
    return result.exitCode === 0 ? parseMacOSMemoryPressure(result.stdout.toString()) : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function parseSwapUsage(output: string): { used: number; total: number } {
  const mac = /total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/i.exec(output)
  const scale = (value: string, unit: string) =>
    Number(value) *
    (unit.toUpperCase() === 'G' ? 1024 ** 3 : unit.toUpperCase() === 'M' ? 1024 ** 2 : 1024)
  if (mac) return { total: scale(mac[1]!, mac[2]!), used: scale(mac[3]!, mac[4]!) }
  const total = /^SwapTotal:\s+(\d+)\s+kB$/m.exec(output)
  const free = /^SwapFree:\s+(\d+)\s+kB$/m.exec(output)
  if (total && free) {
    const totalBytes = Number(total[1]) * 1024
    return { total: totalBytes, used: Math.max(0, totalBytes - Number(free[1]) * 1024) }
  }
  return { used: 0, total: 0 }
}

function readSwap(platform: NodeJS.Platform): { used: number; total: number } {
  try {
    if (platform === 'darwin') {
      const result = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'vm.swapusage'], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: MEMORY_PRESSURE_READ_TIMEOUT_MS,
      })
      return result.exitCode === 0
        ? parseSwapUsage(result.stdout.toString())
        : { used: 0, total: 0 }
    }
    if (platform === 'linux') return parseSwapUsage(readFileSync('/proc/meminfo', 'utf8'))
  } catch {}
  return { used: 0, total: 0 }
}

export function measureHostLoad(
  env: NodeJS.ProcessEnv = process.env,
  selfPid = process.pid,
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): HostLoad {
  const leases = liveLeases(gatePidDir(env), selfPid)
  const swap = readSwap(platform)
  return {
    gates: leases.length,
    loadavg: loadavg()[0] ?? 0,
    ncpu: Math.max(1, cpus().length),
    freeMem: freemem(),
    pressure: readMemoryPressure(platform),
    swapUsed: swap.used,
    swapTotal: swap.total,
    recentAdmissions: leases.filter((lease) => now - lease.admittedAt < HOST_LOAD_RESERVATION_MS)
      .length,
    ...measureHostWaiters(env, selfPid, now),
  }
}

/** Inspect only the lease adapter, without sampling machine load or memory. */
export function measureHostSlotLeases(
  env: NodeJS.ProcessEnv = process.env,
  selfPid = process.pid,
): number {
  return liveLeases(gatePidDir(env), selfPid).length
}

/** Decide admission from measured facts; the adapter owns measurement and process control. */
export function decideHostCapacityAdmission(input: {
  heldWork: number
  loadavg: number
  ncpu: number
  recentAdmissions: number
  freeMem: number
  pressure: MemoryPressure
  limit: number | null
  platform: NodeJS.Platform
  waitedMs?: number
  maxWaitMs?: number
  hasOlderWaiter?: boolean
}): HostCapacityDecision {
  const boundReached = input.maxWaitMs !== undefined && (input.waitedMs ?? 0) >= input.maxWaitMs
  if (boundReached) return { admit: true, heldOn: [], boundReached: true }
  if (input.hasOlderWaiter) return { admit: false, heldOn: ['queue'], boundReached: false }
  // Machine-wide load must never prevent all bottega work from making progress.
  if (input.heldWork === 0) return { admit: true, heldOn: [], boundReached: false }
  const conditions: HostHoldCondition[] = []
  if (input.limit !== null && input.heldWork >= input.limit) conditions.push('gates')
  if (input.loadavg + input.recentAdmissions >= input.ncpu) conditions.push('load')
  const memoryHeld =
    input.platform === 'darwin'
      ? input.pressure === 'warning' || input.pressure === 'critical'
      : input.freeMem < FREE_MEM_FLOOR_BYTES
  if (memoryHeld) conditions.push('memory')
  return { admit: conditions.length === 0, heldOn: conditions, boundReached: false }
}

/** Preserve the gate-specific surface while sharing load and memory policy with runs. */
export function decideHostSlotAdmission(input: {
  heldSlots: number
  loadavg: number
  ncpu: number
  recentAdmissions: number
  freeMem: number
  pressure: MemoryPressure
  limit?: number
  platform: NodeJS.Platform
}): HostSlotDecision {
  const decision = decideHostCapacityAdmission({
    ...input,
    heldWork: input.heldSlots,
    limit: input.limit ?? GATE_CONCURRENCY_LIMIT,
  })
  return { admit: decision.admit, heldOn: decision.heldOn }
}

type GateHoldOpts = {
  env?: NodeJS.ProcessEnv
  measure?: () => HostLoad
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  limit?: number
  platform?: NodeJS.Platform
  signal?: AbortSignal
  onWait?: (state: GateWaitState) => void
  onWaitFinished?: (state: GateWaitState) => void
}

export class HostSlotWaitAborted extends Error {}

export function formatGateWait(state: GateWaitState): string {
  return `waiting ${state.delayedMs}ms for host capacity (gates=${state.load.gates} loadavg=${state.load.loadavg} ncpu=${state.load.ncpu} free_mb=${Math.floor(state.load.freeMem / MEBIBYTE_BYTES)} floor_mb=${Math.floor(FREE_MEM_FLOOR_BYTES / MEBIBYTE_BYTES)} pressure=${state.load.pressure} held_on=${state.heldOn.join('+')})`
}

async function interruptibleSleep(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) throw new HostSlotWaitAborted('host slot wait was cancelled')
  if (!signal) return sleep(ms)
  await Promise.race([
    sleep(ms),
    new Promise<never>((_, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new HostSlotWaitAborted('host slot wait was cancelled')),
        { once: true },
      ),
    ),
  ])
}

function tryAcquireLock(dir: string): (() => void) | null {
  ensureSafeDirectory(dir)
  const path = join(dir, 'acquire.lock')
  const pendingPath = join(dir, `.acquire-${process.pid}-${randomUUID()}`)
  try {
    const fd = openSync(pendingPath, 'wx')
    try {
      writeFileSync(fd, String(process.pid))
    } finally {
      closeSync(fd)
    }
    linkSync(pendingPath, path)
    return () => removeRegularFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      const contents = readRegularFile(path)
      if (contents === null) return null
      const pid = Number(contents)
      if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) {
        removeRegularFile(path)
        console.error(`reclaimed stale host capacity acquisition lock (pid=${pid || 'invalid'})`)
      }
    } catch {}
    return null
  } finally {
    removeRegularFile(pendingPath)
  }
}

type SlotAcquisition = {
  unregisterLease: () => void
  wait: GateWaitState | null
}

function tryReserveHostSlot(input: {
  dir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  now: () => number
  measure?: () => HostLoad
  limit?: number
}):
  | { unregisterLease: () => void; load: null; conditions: [] }
  | { unregisterLease: null; load: HostLoad; conditions: HostHoldCondition[] }
  | null {
  const unlock = tryAcquireLock(input.dir)
  if (!unlock) return null
  try {
    const measured = (
      input.measure ?? (() => measureHostLoad(input.env, process.pid, input.platform, input.now()))
    )()
    const decision = decideHostSlotAdmission({
      heldSlots: measured.gates,
      loadavg: measured.loadavg,
      ncpu: measured.ncpu,
      recentAdmissions: measured.recentAdmissions,
      freeMem: measured.freeMem,
      pressure: measured.pressure,
      limit: input.limit,
      platform: input.platform,
    })
    if (!decision.admit)
      return { unregisterLease: null, load: measured, conditions: decision.heldOn }
    return {
      unregisterLease: registerLease(input.dir, null, input.now()),
      load: null,
      conditions: [],
    }
  } finally {
    unlock()
  }
}

function requireLiveWait(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HostSlotWaitAborted('host slot wait was cancelled')
}

function reportFinishedWait(
  state: GateWaitState | null,
  started: number,
  now: () => number,
  report: GateHoldOpts['onWaitFinished'],
): void {
  if (state) report?.({ ...state, delayedMs: now() - started })
}

async function acquireHostSlot(
  opts: GateHoldOpts,
  env: NodeJS.ProcessEnv,
): Promise<SlotAcquisition> {
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const dir = gatePidDir(env)
  let unregisterWait: (() => void) | null = null
  const started = now()
  const seen = new Set<HostHoldCondition>()
  let finalWait: GateWaitState | null = null
  try {
    if (env.CI) return { unregisterLease: registerLease(dir, null, now()), wait: null }
    for (;;) {
      requireLiveWait(opts.signal)
      const reservation = tryReserveHostSlot({
        dir,
        env,
        platform,
        now,
        measure: opts.measure,
        limit: opts.limit,
      })
      if (reservation?.unregisterLease) {
        return {
          unregisterLease: reservation.unregisterLease,
          wait: finalWait ? { ...finalWait, delayedMs: now() - started } : null,
        }
      }
      if (reservation?.load) {
        for (const condition of reservation.conditions) seen.add(condition)
        unregisterWait ??= registerLease(dir, 'waiters', started)
        finalWait = {
          delayedMs: now() - started,
          load: reservation.load,
          heldOn: GATE_HOLD_CONDITION_ORDER.filter((condition) => seen.has(condition)),
        }
        opts.onWait?.(finalWait)
      }
      await interruptibleSleep(opts.pollMs ?? GATE_HOLD_POLL_MS, opts.signal, sleep)
    }
  } catch (error) {
    reportFinishedWait(finalWait, started, now, opts.onWaitFinished)
    throw error
  } finally {
    unregisterWait?.()
  }
}

export async function withGateSlot<T>(run: () => Promise<T>, opts: GateHoldOpts = {}): Promise<T> {
  const env = opts.env ?? process.env
  if (env[HOST_SLOT_HELD_ENV] === '1') return run()
  const acquired = await acquireHostSlot(opts, env)
  if (acquired.wait) {
    console.error(formatGateWait(acquired.wait))
    opts.onWaitFinished?.(acquired.wait)
  }
  try {
    return await run()
  } finally {
    acquired.unregisterLease()
  }
}
