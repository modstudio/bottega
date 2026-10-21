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

function legacyRunLeaseNumber(name: string): string | null {
  return /^([1-9]\d*)\.lock$/.exec(name)?.[1] ?? null
}

function runLeaseFileName(recordId: string): string {
  return `${recordId}.lock`
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

/** Hold this run's coordinator lease until the returned handle is released. */
export function acquireRunLease(runId: string): KernelLease {
  mkdirSync(leaseDirectory(), { recursive: true })
  return acquireKernelLease(runLeasePath(runId))
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

/** Enumerate only well-formed run lease file identities. */
export function runLeaseIds(): string[] {
  if (!existsSync(leaseDirectory())) return []
  return readdirSync(leaseDirectory()).flatMap((name) => {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.lock$/i.exec(
        name,
      )
    return match ? [match[1]!.toLowerCase()] : []
  })
}
