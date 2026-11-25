import { QUIET_MAX_MS, SLOW_MS } from './collect-cadence.ts'

export const SLOW_COLLECTION_STALE_CADENCES = 3

export type SlowCollectionHealth =
  | { status: 'current'; ageMs: number }
  | { status: 'stale'; ageMs: number }
  | { status: 'missing' | 'invalid'; ageMs: null }

/** Decide collection staleness from the clock and a completion time. */
export function collectionStaleness(
  now: number,
  completedAtIso: string | null,
  staleAfterMs = SLOW_COLLECTION_STALE_CADENCES * SLOW_MS,
): SlowCollectionHealth {
  if (completedAtIso === null) return { status: 'missing', ageMs: null }
  const completedAt = Date.parse(completedAtIso)
  if (!Number.isFinite(completedAt)) return { status: 'invalid', ageMs: null }
  const ageMs = Math.max(0, now - completedAt)
  return {
    status: ageMs > staleAfterMs ? 'stale' : 'current',
    ageMs,
  }
}

/** Decide collection health from the clock and the last completed slow pass. */
export function slowCollectionHealth(now: number, lastSlowAt: string | null): SlowCollectionHealth {
  return collectionStaleness(now, lastSlowAt)
}

/** A quiet tracker may wait through its maximum delay plus one slow cadence. */
export function trackerCollectionStaleness(
  now: number,
  completedAtIso: string | null,
): SlowCollectionHealth {
  return collectionStaleness(now, completedAtIso, QUIET_MAX_MS + SLOW_MS)
}
