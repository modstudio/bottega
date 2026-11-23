// concern: collector leg health
/** Persists collector-leg outcomes and projects their freshness for public read surfaces. */

import type { CollectorLegHealth } from '@bottega/hub-views/work-summary'
import { collectionStaleness } from './collect-slow-health.ts'
import { db, writeTransaction } from './db.ts'
import type { HostedChangeQuarantineSummary } from './hosted-change-quarantine.ts'

const SETTING_PREFIX = 'collect.leg.'

export type CollectorLegState = {
  source: string
  lastSuccessAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failingSince: string | null
}

type UnreadableCollectorLegState = {
  unreadable: true
  key: string
}

export type CollectorLegObservation = CollectorLegState | UnreadableCollectorLegState

function settingKey(source: string): string {
  return `${SETTING_PREFIX}${encodeURIComponent(source)}`
}

function sourceFromSettingKey(key: string): string {
  const encoded = key.slice(SETTING_PREFIX.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
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
  if (!row) return null
  try {
    return parseState(row.value)
  } catch {
    return null
  }
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

export function collectorLegStates(): CollectorLegObservation[] {
  return db()
    .query<{ key: string; value: string }, [string]>(
      'SELECT key,value FROM setting WHERE key LIKE ? ORDER BY key',
    )
    .all(`${SETTING_PREFIX}%`)
    .map((row) => {
      try {
        return parseState(row.value)
      } catch {
        return { unreadable: true, key: row.key }
      }
    })
}

export function collectorLegView(
  states: readonly CollectorLegObservation[],
  now: number,
  hostedChangeQuarantine?: HostedChangeQuarantineSummary,
): { collectedAt: string | null; collectorLegs: CollectorLegHealth[] } {
  const collectorLegs = states.map((state): CollectorLegHealth => {
    if ('unreadable' in state) {
      return {
        source: sourceFromSettingKey(state.key),
        lastSuccessAt: null,
        lastError: 'stored collector leg state is unreadable',
        lastErrorAt: null,
        failingSince: null,
        status: 'unreadable',
        ageMs: null,
      }
    }
    const staleness = collectionStaleness(now, state.lastSuccessAt)
    const quarantine =
      state.source === 'hosted changes' && hostedChangeQuarantine
        ? {
            quarantinedRows: hostedChangeQuarantine.count,
            oldestQuarantinedRow: hostedChangeQuarantine.oldest
              ? {
                  table: hostedChangeQuarantine.oldest.table,
                  constraintError: hostedChangeQuarantine.oldest.constraintError,
                  firstQuarantinedAt: hostedChangeQuarantine.oldest.firstQuarantinedAt,
                }
              : null,
          }
        : {}
    return {
      ...state,
      status:
        state.failingSince !== null
          ? 'failing'
          : staleness.status === 'current'
            ? 'current'
            : 'stale',
      ageMs: staleness.ageMs,
      ...quarantine,
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
