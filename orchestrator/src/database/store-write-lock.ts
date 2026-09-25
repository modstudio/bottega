// concern: database
/** Knows how to inspect and sample SQLite's WAL write lock without opening SQLite. */

import { cc, FFIType, ptr } from 'bun:ffi'
import { closeSync, constants, openSync } from 'node:fs'
import { platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const F_WRLCK = 3
const F_UNLCK = 2
const SEEK_SET = 0
const WAL_WRITE_LOCK = 120
const ORCHESTRATOR_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export type WalWriteLockProbe = number | null | { unsupported: true; reason: string }

export type WalWriteLockClassification = {
  classification: 'free' | 'contended' | 'held'
  holderPid: number | null
}

type WalWriteLockSamples = WalWriteLockClassification & {
  supported: true
  sampleCount: number
  samples: Array<number | null>
}

export type WalWriteLockSampleResult =
  | WalWriteLockSamples
  | { supported: false; reason: string; sampleCount: number }

const darwinFcntl =
  platform() === 'darwin'
    ? cc({
        source: join(ORCHESTRATOR_ROOT, 'src/database/store-write-lock.c'),
        symbols: {
          orch_fcntl_getlk: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        },
      })
    : null

/** Return the process holding SQLite's WAL write byte, without opening SQLite. */
export function probeWalWriteLock(storePath: string): WalWriteLockProbe {
  if (!darwinFcntl) {
    return {
      unsupported: true,
      reason: `WAL write-lock holder probing is unsupported on ${platform()}`,
    }
  }
  let fd: number
  try {
    fd = openSync(`${storePath}-shm`, constants.O_RDWR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  try {
    // Darwin struct flock: off_t start, off_t len, pid_t pid, short type, short whence.
    const bytes = new Uint8Array(24)
    const flock = new DataView(bytes.buffer)
    flock.setBigInt64(0, BigInt(WAL_WRITE_LOCK), true)
    flock.setBigInt64(8, 1n, true)
    flock.setInt16(20, F_WRLCK, true)
    flock.setInt16(22, SEEK_SET, true)
    const errno = darwinFcntl.symbols.orch_fcntl_getlk(fd, ptr(bytes))
    if (errno !== 0) {
      throw new Error(`fcntl(F_GETLK) failed for ${storePath}-shm (errno ${errno})`)
    }
    return flock.getInt16(20, true) === F_UNLCK ? null : flock.getInt32(16, true)
  } finally {
    closeSync(fd)
  }
}

/** Classify repeated holder observations without clocks, files, or processes. */
export function classifyWalWriteLockSamples(
  samples: Array<number | null>,
): WalWriteLockClassification {
  const holders = samples.filter((pid): pid is number => pid !== null)
  if (holders.length === 0) return { classification: 'free', holderPid: null }
  const holderPid = holders.at(-1)!
  if (holders.length === samples.length && holders.every((pid) => pid === holderPid)) {
    return { classification: 'held', holderPid }
  }
  return { classification: 'contended', holderPid }
}

/** Sample the WAL writer over a short, fixed window. */
export async function sampleWalWriteLock(
  storePath: string,
  sampleCount = 5,
  intervalMs = 50,
): Promise<WalWriteLockSampleResult> {
  const samples: Array<number | null> = []
  for (let index = 0; index < sampleCount; index += 1) {
    const probe = probeWalWriteLock(storePath)
    if (probe !== null && typeof probe === 'object') {
      return { supported: false, reason: probe.reason, sampleCount: samples.length }
    }
    samples.push(probe)
    if (index + 1 < sampleCount) await Bun.sleep(intervalMs)
  }
  return {
    supported: true,
    sampleCount: samples.length,
    samples,
    ...classifyWalWriteLockSamples(samples),
  }
}
