// concern: run-coordinator-log
/** Owns detached coordinator log paths, reads, and durable diagnostic shaping. */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import {
  AGENT_CAPACITY_ERROR_NAME,
  ROUTING_REFUSAL_ERROR_NAME,
  ROUTING_REFUSAL_MARKER,
} from '../route/routing-refusal.ts'
import { RUNS_DIR } from './run-artifacts.ts'

const COORDINATOR_ERROR_TAIL_LIMIT = 2000
const SECRET_SHAPED_OUTPUT = '[withheld: secret-shaped content]'

function withoutRoutingRefusalMarker(value: string): string {
  return value
    .replaceAll(`${AGENT_CAPACITY_ERROR_NAME}: `, '')
    .replaceAll(`${ROUTING_REFUSAL_ERROR_NAME}: `, '')
}

function routingRefusalSpan(output: string): { start: number; end: number } | null {
  const start = output.indexOf(ROUTING_REFUSAL_MARKER)
  if (start < 0) return null
  const tail = output.slice(start)
  const stackFrame = /\n[ \t]+at /.exec(tail)
  const followingOutput = /\n[ \t]*\n(?=[ \t]*\S)/.exec(tail)
  const boundary = [stackFrame?.index, followingOutput?.index]
    .filter((value): value is number => value !== undefined)
    .reduce((earliest, value) => Math.min(earliest, value), tail.length)
  return { start, end: start + boundary }
}

function legacyCoordinatorLogNumber(name: string): string | null {
  return /^([1-9]\d*)\.coordinator\.log$/.exec(name)?.[1] ?? null
}

export type CoordinatorLogMigrationCandidate = { name: string; destinationExists: boolean }

export function planCoordinatorLogMigration(
  runsDirectory: string,
  candidates: readonly CoordinatorLogMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan {
  const plan: FilesystemIdentityPlan = { mapped: [], collisions: [], unmapped: [] }
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

/** Bound coordinator diagnostics only after checking the whole candidate tail for secrets. */
export function coordinatorErrorTail(output: string, limit = COORDINATOR_ERROR_TAIL_LIMIT): string {
  const refusal = routingRefusalSpan(output)
  const outsideRoutingRefusal = refusal
    ? `${output.slice(0, refusal.start)}${output.slice(refusal.end)}`
    : output
  const trimmed = (refusal ? withoutRoutingRefusalMarker(output) : output).trim()
  if (!trimmed) return '(no output)'
  if (containsSecretShaped(outsideRoutingRefusal)) return SECRET_SHAPED_OUTPUT
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
