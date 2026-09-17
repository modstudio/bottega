// concern: run-lease
/** Owns run-lifetime kernel lease paths and observation. Must not know run policy or claims. */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRunsDirectory } from '../database-location.ts'
import { acquireKernelLease, type KernelLease, tryKernelLease } from '../project/project-lock.ts'
import type { RunLeaseState } from './run-alive.ts'

const leaseDirectory = () => join(resolveRunsDirectory(process.env), 'leases')

function runLeasePath(runId: number): string {
  return join(leaseDirectory(), `${runId}.lock`)
}

/** Hold this run's coordinator lease until the returned handle is released. */
export function acquireRunLease(runId: number): KernelLease {
  mkdirSync(leaseDirectory(), { recursive: true })
  return acquireKernelLease(runLeasePath(runId))
}

/** Observe a run lease without deleting or otherwise changing its file. */
export function runLeaseState(runId: number): RunLeaseState {
  const path = runLeasePath(runId)
  if (!existsSync(path)) return 'missing'
  const lease = tryKernelLease(path)
  if (!lease) return existsSync(path) ? 'held' : 'missing'
  lease.release()
  return 'free'
}

/** Remove a free lease file while holding its lock; a held lease is untouched. */
export function removeFreeRunLease(runId: number): 'removed' | 'held' | 'missing' {
  const path = runLeasePath(runId)
  if (!existsSync(path)) return 'missing'
  const lease = tryKernelLease(path)
  if (!lease) return existsSync(path) ? 'held' : 'missing'
  try {
    unlinkSync(path)
    return 'removed'
  } finally {
    lease.release()
  }
}

/** Enumerate only well-formed run lease file identities. */
export function runLeaseIds(): number[] {
  if (!existsSync(leaseDirectory())) return []
  return readdirSync(leaseDirectory()).flatMap((name) => {
    const match = /^([1-9]\d*)\.lock$/.exec(name)
    return match ? [Number(match[1])] : []
  })
}
