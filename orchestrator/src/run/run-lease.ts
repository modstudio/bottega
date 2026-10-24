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

type LeaseFileName = (recordId: string) => string

function closeOutLeaseFileIdentity(name: string): RunLeaseFileIdentity | null {
  const suffix = '.close.lock'
  if (!name.endsWith(suffix)) return null
  return leaseFileIdentity(`${name.slice(0, -suffix.length)}.lock`)
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

function runRecordId(runId: string, purpose: string): string {
  const row = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runId)
  if (!row) throw new Error(`no run ${runId} for ${purpose} lease`)
  return row.record_id
}

function runLeasePath(runId: string, purpose: string, fileName: LeaseFileName): string {
  return join(leaseDirectory(), fileName(runRecordId(runId, purpose)))
}

function acquireLease(runId: string, purpose: string, fileName: LeaseFileName): KernelLease {
  mkdirSync(leaseDirectory(), { recursive: true })
  return acquireKernelLease(runLeasePath(runId, purpose, fileName))
}

function requiredLease(
  runId: string,
  purpose: string,
  fileName: LeaseFileName,
  failed: (cause: unknown) => void,
): KernelLease {
  try {
    return acquireLease(runId, purpose, fileName)
  } catch (cause) {
    failed(cause)
    throw cause
  }
}

function removeFreeLease(
  runId: string,
  purpose: string,
  fileName: LeaseFileName,
): 'removed' | 'held' | 'missing' {
  const path = runLeasePath(runId, purpose, fileName)
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

function leaseIds(
  fileIdentity: (name: string) => RunLeaseFileIdentity | null,
  recordsOnly: boolean,
): string[] {
  if (!existsSync(leaseDirectory())) return []
  return readdirSync(leaseDirectory()).flatMap((name) => {
    const identity = fileIdentity(name)
    return identity && (!recordsOnly || identity.kind === 'record') ? [identity.id] : []
  })
}

function heldLeaseIds(
  fileName: LeaseFileName,
  fileIdentity: (name: string) => RunLeaseFileIdentity | null,
): string[] {
  return leaseIds(fileIdentity, false).filter((id) => {
    const path = join(leaseDirectory(), fileName(id))
    const lease = tryKernelLease(path)
    if (!lease) return existsSync(path)
    lease.release()
    return false
  })
}

/** Hold this run's coordinator lease until the returned handle is released. */
export function acquireRunLease(runId: string): KernelLease {
  return acquireLease(runId, 'run', runLeaseFileName)
}

/** Acquire a required coordinator lease while reporting launch failure to its caller. */
export function requiredRunLease(runId: string, failed: (cause: unknown) => void): KernelLease {
  return requiredLease(runId, 'run', runLeaseFileName, failed)
}

/** Acquire a required close-out lease while reporting launch failure to its caller. */
function requiredRunCloseOutLease(runId: string, failed: (cause: unknown) => void): KernelLease {
  return requiredLease(runId, 'close-out', runCloseOutLeaseFileName, failed)
}

/** Hold a required close-out lease until a synchronous or asynchronous action settles. */
export function withRunCloseOutLease<T>(
  runId: string,
  failed: (cause: unknown) => void,
  action: () => Promise<T>,
): Promise<T>
export function withRunCloseOutLease<T>(
  runId: string,
  failed: (cause: unknown) => void,
  action: () => T,
): T
export function withRunCloseOutLease<T>(
  runId: string,
  failed: (cause: unknown) => void,
  action: () => T | Promise<T>,
): T | Promise<T> {
  const lease = requiredRunCloseOutLease(runId, failed)
  try {
    const result = action()
    // Any thenable is still running, not only a native Promise.
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      return Promise.resolve(result).finally(() => releaseRunCloseOutLease(runId, lease))
    }
    releaseRunCloseOutLease(runId, lease)
    return result
  } catch (cause) {
    releaseRunCloseOutLease(runId, lease)
    throw cause
  }
}

/** Observe a run lease without deleting or otherwise changing its file. */
export function runLeaseState(runId: string): RunLeaseState {
  const path = runLeasePath(runId, 'run', runLeaseFileName)
  if (!existsSync(path)) return 'missing'
  const lease = tryKernelLease(path)
  if (!lease) return existsSync(path) ? 'held' : 'missing'
  lease.release()
  return 'free'
}

/** Remove a free lease file while holding its lock; a held lease is untouched. */
export function removeFreeRunLease(runId: string): 'removed' | 'held' | 'missing' {
  return removeFreeLease(runId, 'run', runLeaseFileName)
}

/** Remove a released close-out lease file after closeRun has completed. */
export function removeFreeRunCloseOutLease(runId: string): 'removed' | 'held' | 'missing' {
  return removeFreeLease(runId, 'close-out', runCloseOutLeaseFileName)
}

/** Release a coordinator's close-out lease and remove its now-free file. */
function releaseRunCloseOutLease(runId: string, lease: KernelLease | null): void {
  try {
    lease?.release()
  } finally {
    removeFreeRunCloseOutLease(runId)
  }
}

/** Enumerate only well-formed run lease file identities. */
export function runLeaseIds(): string[] {
  return leaseIds(leaseFileIdentity, true)
}

/** Enumerate only well-formed close-out lease file identities. */
export function runCloseOutLeaseIds(): string[] {
  return leaseIds(closeOutLeaseFileIdentity, true)
}

/** Return the coordinator identities whose kernel leases are held right now. */
export function heldRunLeaseIds(): string[] {
  return heldLeaseIds(runLeaseFileName, leaseFileIdentity)
}

/** Return coordinator identities whose close-out kernel leases are held right now. */
export function heldRunCloseOutLeaseIds(): string[] {
  return heldLeaseIds(runCloseOutLeaseFileName, closeOutLeaseFileIdentity)
}
