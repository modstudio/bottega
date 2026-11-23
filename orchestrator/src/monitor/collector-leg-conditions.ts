// concern: hub collector-leg monitor conditions
/** Reads the hub-owned observation and decides which sustained failures the monitor reports. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const COLLECTOR_LEG_FAILURE_WARN_MS = 10 * 60_000

type CollectorLegObservation = {
  source: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failingSince: string | null
  status: 'current' | 'failing' | 'stale' | 'unreadable'
  ageMs: number | null
  quarantinedRows?: number
  oldestQuarantinedRow?: {
    table: string
    constraintError: string
    firstQuarantinedAt: string
  } | null
}

export type CollectorLegFailure = {
  source: string
  failingSince: string
  lastError: string | null
  ageMs: number
}

function observationError(detail: string): string {
  return `collector leg observation unreadable: ${detail}`
}

function hostedRowQuarantineDecision(
  leg: CollectorLegObservation,
  now: number,
): { condition: MonitorCondition | null; error: string | null } {
  const count = leg.quarantinedRows ?? 0
  const oldest = leg.oldestQuarantinedRow
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    (count > 0 &&
      (!oldest ||
        typeof oldest.table !== 'string' ||
        typeof oldest.constraintError !== 'string' ||
        typeof oldest.firstQuarantinedAt !== 'string'))
  )
    return {
      condition: null,
      error: observationError(`${leg.source} had invalid quarantine fields`),
    }
  if (count === 0) return { condition: null, error: null }
  const since = Date.parse(oldest!.firstQuarantinedAt)
  if (!Number.isFinite(since))
    return {
      condition: null,
      error: observationError(`${leg.source} had an invalid quarantine timestamp`),
    }
  return {
    condition: {
      kind: 'hosted-row-quarantined',
      subject: leg.source,
      since: oldest!.firstQuarantinedAt,
      ageMs: Math.max(0, now - since),
      detail: `${count} hosted ${count === 1 ? 'row is' : 'rows are'} quarantined; oldest is ${oldest!.table}: ${oldest!.constraintError}`,
      action: `list quarantined rows with ${PLATFORM_SLUG} record collector-legs --quarantined --json, fix the local constraint, and collect again`,
    },
    error: null,
  }
}

function parsedObservations(value: unknown): {
  observations: CollectorLegObservation[]
  errors: string[]
} {
  if (!Array.isArray(value))
    return { observations: [], errors: [observationError('response was not an array')] }
  const observations: CollectorLegObservation[] = []
  const errors: string[] = []
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(observationError(`leg ${index} was not an object`))
      return
    }
    const row = item as Partial<CollectorLegObservation>
    const nullableString = (field: unknown) => field === null || typeof field === 'string'
    const validStatus =
      row.status === 'current' ||
      row.status === 'failing' ||
      row.status === 'stale' ||
      row.status === 'unreadable'
    if (
      typeof row.source !== 'string' ||
      !nullableString(row.lastSuccessAt) ||
      !nullableString(row.lastError) ||
      !nullableString(row.lastErrorAt) ||
      !nullableString(row.failingSince) ||
      !validStatus ||
      !(row.ageMs === null || (typeof row.ageMs === 'number' && Number.isFinite(row.ageMs)))
    ) {
      errors.push(observationError(`leg ${index} contained invalid fields`))
      return
    }
    const observation = row as CollectorLegObservation
    if (observation.status === 'unreadable') {
      errors.push(observationError(`${observation.source} state is unreadable`))
      return
    }
    observations.push(observation)
  })
  return { observations, errors }
}

/** Pure decision over the hub command's already-observed JSON value. */
export function collectorLegFailureDecision(
  value: unknown,
  now: number,
): { conditions: MonitorCondition[]; errors: string[]; failures: CollectorLegFailure[] } {
  const { observations, errors } = parsedObservations(value)
  const conditions: MonitorCondition[] = []
  const failures: CollectorLegFailure[] = []
  for (const leg of observations) {
    const quarantine = hostedRowQuarantineDecision(leg, now)
    if (quarantine.condition) conditions.push(quarantine.condition)
    if (quarantine.error) errors.push(quarantine.error)
    if (leg.failingSince === null) continue
    const since = Date.parse(leg.failingSince)
    if (!Number.isFinite(since)) {
      errors.push(observationError(`${leg.source} had an invalid failingSince`))
      continue
    }
    const ageMs = Math.max(0, now - since)
    if (ageMs <= COLLECTOR_LEG_FAILURE_WARN_MS) continue
    failures.push({
      source: leg.source,
      failingSince: leg.failingSince,
      lastError: leg.lastError,
      ageMs,
    })
    const ageMinutes = Math.floor(ageMs / 60_000)
    conditions.push({
      kind: 'collector-leg-failure',
      subject: leg.source,
      since: leg.failingSince,
      ageMs,
      detail: `${leg.source} collection has failed for ${ageMinutes} minutes: ${leg.lastError ?? 'error unavailable'}`,
      action: `fix the named hub collector failure, then run ${PLATFORM_SLUG} record collector-legs --json to confirm recovery`,
    })
  }
  return { conditions, errors, failures }
}

export function observeCollectorLegFailures(
  now = Date.now(),
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): { conditions: MonitorCondition[]; errors: string[]; failures: CollectorLegFailure[] } {
  const command = [...bottegaEntryArgv(PLATFORM_SLUG), 'record', 'collector-legs', '--json']
  try {
    const child = spawn(command, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
    if (child.exitCode !== 0) {
      const detail = child.stderr.toString().trim() || `exit status ${child.exitCode}`
      return {
        conditions: [],
        errors: [`collector leg observation unavailable: ${detail}`],
        failures: [],
      }
    }
    const value: unknown = JSON.parse(child.stdout.toString())
    return collectorLegFailureDecision(value, now)
  } catch (cause) {
    return {
      conditions: [],
      failures: [],
      errors: [
        `collector leg observation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    }
  }
}
