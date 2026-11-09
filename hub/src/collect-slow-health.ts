import { SLOW_MS } from './collect-cadence.ts'

export const SLOW_COLLECTION_STALE_CADENCES = 3

export type SlowCollectionHealth =
  | { status: 'current'; ageMs: number }
  | { status: 'stale'; ageMs: number }
  | { status: 'missing' | 'invalid'; ageMs: null }

/** Decide collection health from the clock and the last completed slow pass. */
export function slowCollectionHealth(now: number, lastSlowAt: string | null): SlowCollectionHealth {
  if (lastSlowAt === null) return { status: 'missing', ageMs: null }
  const completedAt = Date.parse(lastSlowAt)
  if (!Number.isFinite(completedAt)) return { status: 'invalid', ageMs: null }
  const ageMs = Math.max(0, now - completedAt)
  return {
    status: ageMs > SLOW_COLLECTION_STALE_CADENCES * SLOW_MS ? 'stale' : 'current',
    ageMs,
  }
}
