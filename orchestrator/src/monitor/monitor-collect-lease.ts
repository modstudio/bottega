// concern: monitor-collect-lease
/** Observes the hub-owned collect lease through its public read-only command. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { MonitorCondition } from './monitor-types.ts'

export const COLLECT_LEASE_HELD_WARN_MS = 60_000

type CollectLeaseObservation = {
  free: boolean
  holder: string | null
  since: number | null
  age: number | null
  until: number | null
}

/** Decide whether an already-observed collect lease has exceeded the warning threshold. */
export function collectLeaseHeldCondition(
  holder: string | null,
  since: number | null,
  now: number,
): MonitorCondition | null {
  if (holder === null || since === null) return null
  const ageMs = Math.max(0, now - since)
  if (ageMs <= COLLECT_LEASE_HELD_WARN_MS) return null
  return {
    kind: 'collect-lease-held',
    subject: holder,
    since: new Date(since).toISOString(),
    ageMs,
    detail: `collect lease has been held by ${holder} for ${ageMs}ms`,
    action: `wait, or check the holder with ${PLATFORM_SLUG} record lease`,
  }
}

function parsedCollectLease(value: unknown): CollectLeaseObservation {
  if (!value || typeof value !== 'object') throw new Error('response was not an object')
  const row = value as Partial<CollectLeaseObservation>
  if (row.free === true) {
    if (row.holder !== null || row.since !== null || row.age !== null || row.until !== null)
      throw new Error('free response contained holder fields')
    return { free: true, holder: null, since: null, age: null, until: null }
  }
  if (
    row.free !== false ||
    typeof row.holder !== 'string' ||
    (row.since !== null && typeof row.since !== 'number') ||
    (row.age !== null && typeof row.age !== 'number') ||
    typeof row.until !== 'number'
  )
    throw new Error('held response contained invalid lease fields')
  return {
    free: false,
    holder: row.holder,
    since: row.since ?? null,
    age: row.age ?? null,
    until: row.until,
  }
}

export function observeCollectLease(
  now = Date.now(),
  spawn: typeof Bun.spawnSync = Bun.spawnSync,
): { conditions: MonitorCondition[]; errors: string[] } {
  const command = [...bottegaEntryArgv(PLATFORM_SLUG), 'record', 'lease', '--json']
  try {
    const child = spawn(command, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
    if (child.exitCode !== 0) {
      const detail = child.stderr.toString().trim() || `exit status ${child.exitCode}`
      return { conditions: [], errors: [`collect lease observation unavailable: ${detail}`] }
    }
    const lease = parsedCollectLease(JSON.parse(child.stdout.toString()))
    const condition = collectLeaseHeldCondition(lease.holder, lease.since, now)
    return { conditions: condition ? [condition] : [], errors: [] }
  } catch (cause) {
    return {
      conditions: [],
      errors: [
        `collect lease observation unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    }
  }
}
