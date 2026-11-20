// concern: collector leg health
/** Persists collector-leg outcomes and projects their freshness for public read surfaces. */

import { SLOW_MS } from './collect-cadence.ts'
import { db, writeTransaction } from './db.ts'

const SETTING_PREFIX = 'collect.leg.'
const COLLECTOR_LEG_STALE_MS = 3 * SLOW_MS

export type CollectorLegState = {
  source: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failingSince: string | null
}

export type CollectorLegHealth = CollectorLegState & {
  status: 'current' | 'failing' | 'stale'
  ageMs: number | null
}

function settingKey(source: string): string {
  return `${SETTING_PREFIX}${encodeURIComponent(source)}`
}

function parseState(value: string): CollectorLegState {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object')
    throw new Error('collector leg state was not an object')
  const row = parsed as Partial<CollectorLegState>
  const nullableString = (item: unknown) => item === null || typeof item === 'string'
  if (
    typeof row.source !== 'string' ||
    !nullableString(row.lastSuccessAt) ||
    !nullableString(row.lastError) ||
    !nullableString(row.lastErrorAt) ||
    !nullableString(row.failingSince)
  )
    throw new Error(`collector leg state for ${row.source ?? 'unknown'} had invalid fields`)
  return row as CollectorLegState
}

function storedState(source: string): CollectorLegState | null {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key = ?')
    .get(settingKey(source))
  return row ? parseState(row.value) : null
}

function storeState(state: CollectorLegState): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(settingKey(state.source), JSON.stringify(state)),
  )
}

export function recordCollectorLegFailure(
  source: string,
  error: string,
  at: string,
): { logFailure: boolean } {
  const previous = storedState(source)
  storeState({
    source,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastError: error,
    lastErrorAt: at,
    failingSince: previous?.failingSince ?? at,
  })
  return { logFailure: previous?.failingSince == null || previous.lastError !== error }
}

export function recordCollectorLegSuccess(source: string, at: string): { logRecovery: boolean } {
  const previous = storedState(source)
  storeState({
    source,
    lastSuccessAt: at,
    lastError: previous?.lastError ?? null,
    lastErrorAt: previous?.lastErrorAt ?? null,
    failingSince: null,
  })
  return { logRecovery: previous?.failingSince != null }
}

export function collectorLegStates(): CollectorLegState[] {
  return db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key LIKE ? ORDER BY key')
    .all(`${SETTING_PREFIX}%`)
    .map((row) => parseState(row.value))
}

export function collectorLegView(
  states: readonly CollectorLegState[],
  now = Date.now(),
): { collectedAt: string | null; collectorLegs: CollectorLegHealth[] } {
  const collectorLegs = states.map((state): CollectorLegHealth => {
    const successMs = state.lastSuccessAt === null ? Number.NaN : Date.parse(state.lastSuccessAt)
    const ageMs = Number.isFinite(successMs) ? Math.max(0, now - successMs) : null
    return {
      ...state,
      status:
        state.failingSince !== null
          ? 'failing'
          : ageMs === null || ageMs > COLLECTOR_LEG_STALE_MS
            ? 'stale'
            : 'current',
      ageMs,
    }
  })
  const successes = collectorLegs.flatMap((leg) =>
    leg.lastSuccessAt === null ? [] : [leg.lastSuccessAt],
  )
  return {
    collectedAt:
      successes.length === collectorLegs.length && successes.length > 0
        ? successes.reduce((oldest, value) => (value < oldest ? value : oldest))
        : null,
    collectorLegs,
  }
}
