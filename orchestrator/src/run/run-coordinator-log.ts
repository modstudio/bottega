// concern: run-coordinator-log
/** Owns detached coordinator log paths, reads, and durable diagnostic shaping. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import { RUNS_DIR } from './run-artifacts.ts'

const COORDINATOR_ERROR_TAIL_LIMIT = 2000
const SECRET_SHAPED_OUTPUT = '[withheld: secret-shaped content]'

function legacyCoordinatorLogNumber(name: string): string | null {
  return /^([1-9]\d*)\.coordinator\.log$/.exec(name)?.[1] ?? null
}

export type CoordinatorLogMigrationCandidate = {
  name: string
  destinationExists: boolean
}

export function planCoordinatorLogMigration(
  runsDirectory: string,
  candidates: readonly CoordinatorLogMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  const plan: FilesystemIdentityPlan = {
    mapped: [],
    collisions: [],
    unmapped: [],
  }
  for (const candidate of candidates) {
    const number = legacyCoordinatorLogNumber(candidate.name)
    if (!number) continue
    const source = join(runsDirectory, candidate.name)
    const run = runs.get(number)
    if (!run) {
      plan.unmapped.push({ source, number })
      continue
    }
    const move = {
      source,
      destination: join(runsDirectory, run.recordId, 'coordinator.log'),
      run,
      payload: undefined,
    }
    ;(candidate.destinationExists ? plan.collisions : plan.mapped).push(move)
  }
  return plan
}

export function discoverCoordinatorLogMigration(
  runsDirectory: string,
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  if (!existsSync(runsDirectory)) return { mapped: [], collisions: [], unmapped: [] }
  return planCoordinatorLogMigration(
    runsDirectory,
    readdirSync(runsDirectory).map((name) => {
      const number = legacyCoordinatorLogNumber(name)
      const run = number ? runs.get(number) : undefined
      return {
        name,
        destinationExists: Boolean(
          run && existsSync(join(runsDirectory, run.recordId, 'coordinator.log')),
        ),
      }
    }),
    runs,
  )
}

export function applyCoordinatorLogMigration(plan: FilesystemIdentityPlan): number {
  for (const move of plan.mapped) {
    mkdirSync(dirname(move.destination), { recursive: true })
    renameSync(move.source, move.destination)
  }
  return plan.mapped.length
}

/** A detached coordinator's diagnostics, keyed by the run's machine identity. */
export const runCoordinatorLogPath = (runRecordId: string, runsDir = RUNS_DIR): string =>
  join(runsDir, runRecordId, 'coordinator.log')

const runCoordinatorCausePath = (runRecordId: string, runsDir = RUNS_DIR): string =>
  join(runsDir, runRecordId, 'coordinator-cause.txt')

/** Preserve a failure that this process cannot write to a newly migrated store. */
export function recordCoordinatorCause(runRecordId: string, cause: string): void {
  mkdirSync(join(RUNS_DIR, runRecordId), { recursive: true })
  writeFileSync(runCoordinatorCausePath(runRecordId), cause)
}

export function recordedCoordinatorCause(runRecordId: string): string | null {
  try {
    return readFileSync(runCoordinatorCausePath(runRecordId), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** Bound coordinator diagnostics only after checking the whole candidate tail for secrets. */
export function coordinatorErrorTail(output: string, limit = COORDINATOR_ERROR_TAIL_LIMIT): string {
  const trimmed = output.trim()
  if (!trimmed) return '(no output)'
  if (containsSecretShaped(trimmed)) return SECRET_SHAPED_OUTPUT
  if (trimmed.length <= limit) return trimmed
  const marker = '… [earlier output omitted] …\n'
  if (limit <= marker.length) return trimmed.slice(-limit)
  return `${marker}${trimmed.slice(-(limit - marker.length))}`
}

/** Shape the durable failure text for a coordinator that died during setup. */
export function coordinatorSetupError(runRecordId: string): string {
  let output = ''
  try {
    output = readFileSync(runCoordinatorLogPath(runRecordId), 'utf8')
  } catch {
    // A missing or unreadable log is still an observed setup death.
  }
  return `coordinator exited during setup before the agent started; last output: ${coordinatorErrorTail(output)}`
}
