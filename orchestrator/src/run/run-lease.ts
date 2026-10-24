// concern: run-lease
/** Owns run-lifetime kernel lease paths and observation. Must not know run policy or claims. */

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { db } from '../database/db.ts'
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import { acquireKernelLease, type KernelLease, tryKernelLease } from '../project/project-lock.ts'
import type { RunLeaseState } from './run-alive.ts'

const leaseDirectory = () => join(resolveRunsDirectory(process.env), 'leases')

type RunLeaseFileIdentity = { kind: 'legacy'; id: string } | { kind: 'record'; id: string }

/** Parse the one run-lease file-name grammar used by migration and observation. */
function leaseFileIdentity(name: string): RunLeaseFileIdentity | null {
  const match =
    /^((?:[1-9]\d*)|(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))\.lock$/i.exec(
      name,
    )
  if (!match) return null
  const id = match[1]!.toLowerCase()
  return /^\d+$/.test(id) ? { kind: 'legacy', id } : { kind: 'record', id }
}

function legacyRunLeaseNumber(name: string): string | null {
  const identity = leaseFileIdentity(name)
  return identity?.kind === 'legacy' ? identity.id : null
}

function runLeaseFileName(recordId: string): string {
  return `${recordId}.lock`
}

function runCloseOutLeaseFileName(recordId: string): string {
  return `${recordId}.close.lock`
}

export type RunLeaseMigrationCandidate = { name: string; destinationExists: boolean }

export function planRunLeaseMigration(
  directory: string,
  candidates: readonly RunLeaseMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  const plan: FilesystemIdentityPlan = { mapped: [], collisions: [], unmapped: [] }
  for (const candidate of candidates) {
    const number = legacyRunLeaseNumber(candidate.name)
    if (!number) continue
    const source = join(directory, candidate.name)
    const run = runs.get(number)
    if (!run) {
      plan.unmapped.push({ source, number })
      continue
    }
    const move = {
      source,
      destination: join(directory, runLeaseFileName(run.recordId)),
      run,
      payload: undefined,
    }
    ;(candidate.destinationExists ? plan.collisions : plan.mapped).push(move)
  }
  return plan
}

export function discoverRunLeaseMigration(
  runsDirectory: string,
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  const directory = join(runsDirectory, 'leases')
  if (!existsSync(directory)) return { mapped: [], collisions: [], unmapped: [] }
  return planRunLeaseMigration(
    directory,
    readdirSync(directory).map((name) => {
      const number = legacyRunLeaseNumber(name)
      const run = number ? runs.get(number) : undefined
      return {
        name,
        destinationExists: Boolean(
          run && existsSync(join(directory, runLeaseFileName(run.recordId))),
        ),
      }
    }),
    runs,
  )
}

export function applyRunLeaseMigration(plan: FilesystemIdentityPlan): number {
  for (const move of plan.mapped) renameSync(move.source, move.destination)
  return plan.mapped.length
}

function runLeasePath(runId: string): string {
  const row = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runId)
  if (!row) throw new Error(`no run ${runId} for run lease`)
  return join(leaseDirectory(), runLeaseFileName(row.record_id))
}

function runCloseOutLeasePath(runId: string): string {
  const row = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runId)
  if (!row) throw new Error(`no run ${runId} for close-out lease`)
  return join(leaseDirectory(), runCloseOutLeaseFileName(row.record_id))
}

/** Hold this run's coordinator lease until the returned handle is released. */
export function acquireRunLease(runId: string): KernelLease {
  mkdirSync(leaseDirectory(), { recursive: true })
  return acquireKernelLease(runLeasePath(runId))
}

/** Hold a coordinator's close-out lease independently of conversation liveness. */
export function acquireRunCloseOutLease(runId: string): KernelLease {
  mkdirSync(leaseDirectory(), { recursive: true })
  return acquireKernelLease(runCloseOutLeasePath(runId))
}

/** Acquire a required coordinator lease while reporting launch failure to its caller. */
export function requiredRunLease(runId: string, failed: (cause: unknown) => void): KernelLease {
  try {
    return acquireRunLease(runId)
  } catch (cause) {
    failed(cause)
    throw cause
  }
}

/** Acquire a required close-out lease while reporting launch failure to its caller. */
export function requiredRunCloseOutLease(
  runId: string,
  failed: (cause: unknown) => void,
): KernelLease {
  try {
    return acquireRunCloseOutLease(runId)
  } catch (cause) {
    failed(cause)
    throw cause
  }
}

/** Observe a run lease without deleting or otherwise changing its file. */
export function runLeaseState(runId: string): RunLeaseState {
  const path = runLeasePath(runId)
  if (!existsSync(path)) return 'missing'
  const lease = tryKernelLease(path)
  if (!lease) return existsSync(path) ? 'held' : 'missing'
  lease.release()
  return 'free'
}

/** Remove a free lease file while holding its lock; a held lease is untouched. */
export function removeFreeRunLease(runId: string): 'removed' | 'held' | 'missing' {
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

/** Remove a released close-out lease file after closeRun has completed. */
export function removeFreeRunCloseOutLease(runId: string): 'removed' | 'held' | 'missing' {
  const path = runCloseOutLeasePath(runId)
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

function releaseRunCloseOutLease(runId: string, lease: KernelLease | null): void {
  lease?.release()
  removeFreeRunCloseOutLease(runId)
}

/** Release the close-out lease when finishRun failed before closeRun could start. */
export function releaseAbortedRunCloseOutLease(
  finishCompleted: boolean,
  runId: string,
  lease: KernelLease | null,
): void {
  if (!finishCompleted) releaseRunCloseOutLease(runId, lease)
}

/** Hold the close-out lease through the complete closeRun call, including failures. */
export function withRunCloseOutLease<T>(
  runId: string,
  lease: KernelLease | null,
  action: () => T,
): T {
  try {
    return action()
  } finally {
    releaseRunCloseOutLease(runId, lease)
  }
}

/** Enumerate only well-formed run lease file identities. */
export function runLeaseIds(): string[] {
  if (!existsSync(leaseDirectory())) return []
  return readdirSync(leaseDirectory()).flatMap((name) => {
    const identity = leaseFileIdentity(name)
    return identity?.kind === 'record' ? [identity.id] : []
  })
}

/** Return the coordinator identities whose kernel leases are held right now. */
export function heldRunLeaseIds(): string[] {
  if (!existsSync(leaseDirectory())) return []
  const identities = readdirSync(leaseDirectory()).flatMap((name) => {
    const identity = leaseFileIdentity(name)
    return identity ? [identity.id] : []
  })
  return identities.filter((id) => {
    const path = join(leaseDirectory(), `${id}.lock`)
    const lease = tryKernelLease(path)
    if (!lease) return existsSync(path)
    lease.release()
    return false
  })
}

/** Return coordinator identities whose close-out kernel leases are held right now. */
export function heldRunCloseOutLeaseIds(): string[] {
  if (!existsSync(leaseDirectory())) return []
  const suffix = '.close.lock'
  const identities = readdirSync(leaseDirectory()).flatMap((name) => {
    if (!name.endsWith(suffix)) return []
    const identity = leaseFileIdentity(`${name.slice(0, -suffix.length)}.lock`)
    return identity ? [identity.id] : []
  })
  return identities.filter((id) => {
    const path = join(leaseDirectory(), runCloseOutLeaseFileName(id))
    const lease = tryKernelLease(path)
    if (!lease) return existsSync(path)
    lease.release()
    return false
  })
}
