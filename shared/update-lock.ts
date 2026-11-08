// concern: machine update serialization
/** Holds the machine-wide update lease in the per-user state directory. */

import { dlopen, FFIType } from 'bun:ffi'
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { processCommandLine } from './process-identity.ts'
import { resolveStateRoot, type StateEnvironment } from './state-directory.ts'

export const MACHINE_UPDATE_LOCK_FILE = 'machine-update.lock'
export const MACHINE_UPDATE_INTENT_FILE = 'machine-update-intent.json'
export const MACHINE_UPDATE_LOCK_HELD_ENV = `${PLATFORM_SLUG.toUpperCase()}_MACHINE_UPDATE_LOCK_HELD`
// Claude command logs, measured 2026-11-07, showed a 155.033s maximum update; round upward.
export const MACHINE_UPDATE_LOCK_WAIT_MS = 3 * 60_000
const MACHINE_UPDATE_LOCK_POLL_MS = 100

const flockLibrary = dlopen(platform() === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const flock = flockLibrary.symbols.flock
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

export type MachineUpdateLockHolder = { pid: number; command: string }

export function machineUpdateLockPath(env: StateEnvironment): string {
  return join(resolveStateRoot(env), MACHINE_UPDATE_LOCK_FILE)
}

export function machineUpdateIntentPath(env: StateEnvironment): string {
  return join(resolveStateRoot(env), MACHINE_UPDATE_INTENT_FILE)
}

function readHolder(path: string): MachineUpdateLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MachineUpdateLockHolder>
    return Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.command === 'string'
      ? { pid: Number(parsed.pid), command: parsed.command }
      : null
  } catch {
    return null
  }
}

export function machineUpdateLockRefusal(holder: MachineUpdateLockHolder | null): string {
  const identity = holder
    ? `pid ${holder.pid}, command ${holder.command}`
    : 'holder pid and command could not be read'
  return `another update is running: ${identity}; wait for it to finish, then rerun ${PLATFORM_SLUG} machine update`
}

export async function withMachineUpdateLock<T>(
  action: () => Promise<T> | T,
  options: {
    env?: StateEnvironment
    waitMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<T> {
  const env = options.env ?? process.env
  const root = resolveStateRoot(env)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = machineUpdateLockPath(env)
  const started = (options.now ?? Date.now)()
  const waitMs = options.waitMs ?? MACHINE_UPDATE_LOCK_WAIT_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  let descriptor: number
  for (;;) {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600)
    if (flock(descriptor, LOCK_EX | LOCK_NB) === 0) break
    closeSync(descriptor)
    if (now() - started >= waitMs) throw new Error(machineUpdateLockRefusal(readHolder(path)))
    await sleep(MACHINE_UPDATE_LOCK_POLL_MS)
  }
  try {
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        command: processCommandLine(process.pid) ?? process.argv.join(' '),
      }),
      { mode: 0o600 },
    )
    return await action()
  } finally {
    flock(descriptor, LOCK_UN)
    closeSync(descriptor)
  }
}
