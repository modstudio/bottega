// concern: hub collector-leg monitor conditions
/** Reads the hub-owned observation and decides which sustained failures the monitor reports. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const COLLECTOR_LEG_FAILURE_WARN_MS = 60_000

type CollectorLegObservation = {
  source: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failingSince: string | null
}

function parsedObservations(value: unknown): CollectorLegObservation[] {
  if (!Array.isArray(value)) throw new Error('response was not an array')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`leg ${index} was not an object`)
    const row = item as Partial<CollectorLegObservation>
    const nullableString = (field: unknown) => field === null || typeof field === 'string'
    if (
      typeof row.source !== 'string' ||
      !nullableString(row.lastSuccessAt) ||
      !nullableString(row.lastError) ||
      !nullableString(row.lastErrorAt) ||
      !nullableString(row.failingSince)
    )
      throw new Error(`leg ${index} contained invalid fields`)
    return row as CollectorLegObservation
  })
}

/** Pure decision over the hub command's already-observed JSON value. */
export function collectorLegFailureDecision(
  value: unknown,
  now: number,
): { conditions: MonitorCondition[]; errors: string[] } {
  try {
    const conditions = parsedObservations(value).flatMap((leg): MonitorCondition[] => {
      if (leg.failingSince === null) return []
      const since = Date.parse(leg.failingSince)
      if (!Number.isFinite(since)) throw new Error(`${leg.source} had an invalid failingSince`)
      const ageMs = Math.max(0, now - since)
      if (ageMs <= COLLECTOR_LEG_FAILURE_WARN_MS) return []
      return [
        {
          kind: 'collector-leg-failure',
          subject: leg.source,
          since: leg.failingSince,
          ageMs,
          detail: `${leg.source} collection has failed for ${ageMs}ms: ${leg.lastError ?? 'error unavailable'}`,
          action: `fix the named hub collector failure, then run ${PLATFORM_SLUG} record collector-legs --json to confirm recovery`,
        },
      ]
    })
    return { conditions, errors: [] }
  } catch (cause) {
    return {
      conditions: [],
      errors: [
        `collector leg observation unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    }
  }
}

export function observeCollectorLegFailures(
  now = Date.now(),
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): { conditions: MonitorCondition[]; errors: string[] } {
  const command = [...bottegaEntryArgv(PLATFORM_SLUG), 'record', 'collector-legs', '--json']
  try {
    const child = spawn(command, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
    if (child.exitCode !== 0) {
      const detail = child.stderr.toString().trim() || `exit status ${child.exitCode}`
      return { conditions: [], errors: [`collector leg observation unavailable: ${detail}`] }
    }
    return collectorLegFailureDecision(JSON.parse(child.stdout.toString()), now)
  } catch (cause) {
    return {
      conditions: [],
      errors: [
        `collector leg observation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    }
  }
}
