// concern: monitor-hosted-pressure
/** Reads Fly metrics and owns the machine-wide hosted-pressure cache claim. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readEnvValuesWithHosted } from '../../../shared/env-source.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, writeTransaction } from '../database/db.ts'
import {
  CLEAR_HOSTED_PRESSURE_STATE,
  decideHostedPressure,
  type HostedPressureDecision,
  type HostedPressureObservation,
  type HostedPressureState,
} from './hosted-pressure-decision.ts'

export const HOSTED_METRICS_QUERY_BUDGET_MS = 3_000
export const HOSTED_METRICS_INTERVAL_MS = 5 * 60_000
export const HOSTED_METRICS_ORG = PLATFORM_SLUG
export const HOSTED_RECORD_APP = `${PLATFORM_SLUG}-record`
export const HOSTED_API_APP = `${PLATFORM_SLUG}-api`
export const HOSTED_METRICS_WINDOW = '5m'
export const HOSTED_FLY_METRICS_TOKEN = 'BOTTEGA_FLY_METRICS_TOKEN'

export const HOSTED_METRICS_QUERIES = {
  steal: `sum(rate(fly_instance_cpu{app="${HOSTED_RECORD_APP}",mode="steal"}[${HOSTED_METRICS_WINDOW}])) / sum(rate(fly_instance_cpu{app="${HOSTED_RECORD_APP}"}[${HOSTED_METRICS_WINDOW}]))`,
  throttle: `sum(rate(fly_instance_cpu_throttle{app="${HOSTED_RECORD_APP}"}[${HOSTED_METRICS_WINDOW}])) / sum(rate(fly_instance_cpu{app="${HOSTED_RECORD_APP}"}[${HOSTED_METRICS_WINDOW}]))`,
  balance: `min(fly_instance_cpu_balance{app="${HOSTED_RECORD_APP}"})`,
  'api-p95': `histogram_quantile(0.95, sum by (le) (rate(fly_app_http_response_time_seconds_bucket{app="${HOSTED_API_APP}"}[${HOSTED_METRICS_WINDOW}])))`,
} as const

type QueryName = keyof typeof HOSTED_METRICS_QUERIES
type Dependencies = {
  database?: Database
  clock?: number
  fetch?: typeof globalThis.fetch
  resolveToken?: typeof readEnvValuesWithHosted
  failFastStoreClaim?: boolean
}
type CacheRow = {
  checked_at: string
  state: string
  last_sample: string | null
  last_error: string | null
}

function authorization(token: string): string {
  return token.startsWith('FlyV1 ') ? token : `FlyV1 ${token}`
}

async function queryMetric(
  name: QueryName,
  token: string,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<number | 'absent'> {
  const url = new URL(`https://api.fly.io/prometheus/${HOSTED_METRICS_ORG}/api/v1/query`)
  url.searchParams.set('query', HOSTED_METRICS_QUERIES[name])
  const response = await fetcher(url, {
    headers: { Authorization: authorization(token) },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as {
    status?: string
    data?: { result?: { value?: [number, string] }[] }
    error?: string
  }
  if (body.status !== 'success')
    throw new Error(body.error ?? 'Prometheus response was not success')
  const value = body.data?.result?.[0]?.value?.[1]
  if (value === undefined) return 'absent'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`non-numeric value ${value}`)
  return parsed
}

async function observeHostedMetrics(
  at: string,
  deps: Required<Pick<Dependencies, 'fetch' | 'resolveToken'>>,
): Promise<HostedPressureObservation> {
  let token: string | undefined
  try {
    token = (await deps.resolveToken([HOSTED_FLY_METRICS_TOKEN]))[HOSTED_FLY_METRICS_TOKEN]
  } catch (error) {
    return { kind: 'failed', query: 'token', error: String(error), at }
  }
  if (!token) return { kind: 'unconfigured', at }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HOSTED_METRICS_QUERY_BUDGET_MS)
  try {
    const entries = await Promise.all(
      (Object.keys(HOSTED_METRICS_QUERIES) as QueryName[]).map(async (name) => {
        try {
          return [name, await queryMetric(name, token, controller.signal, deps.fetch)] as const
        } catch (error) {
          throw { name, error }
        }
      }),
    )
    const values = Object.fromEntries(entries) as Record<QueryName, number | 'absent'>
    return {
      kind: 'sample',
      stealFraction: values.steal,
      throttleFraction: values.throttle,
      balance: values.balance,
      apiP95Seconds: values['api-p95'],
      at,
    }
  } catch (failure) {
    const item = failure as { name?: string; error?: unknown }
    return { kind: 'failed', query: item.name ?? 'unknown', error: String(item.error), at }
  } finally {
    clearTimeout(timeout)
  }
}

function parseState(value: string | null): HostedPressureState {
  if (!value) return CLEAR_HOSTED_PRESSURE_STATE
  return JSON.parse(value) as HostedPressureState
}

function cachedDecision(row: CacheRow): HostedPressureDecision {
  const state = parseState(row.state)
  if (row.last_sample) {
    return decideHostedPressure(state, JSON.parse(row.last_sample) as HostedPressureObservation)
  }
  if (row.last_error) {
    return decideHostedPressure(state, {
      kind: 'failed',
      query: 'cached',
      error: row.last_error,
      at: row.checked_at,
    })
  }
  return { state, conditions: [] }
}

function claimTransaction<T>(database: Database, failFast: boolean | undefined, fn: () => T): T {
  if (!failFast) return writeTransaction(fn, database)
  database.exec('PRAGMA busy_timeout = 0')
  try {
    return writeTransaction(fn, database)
  } finally {
    database.exec('PRAGMA busy_timeout = 15000')
  }
}

/** Claim one interval, observe outside the transaction, then persist the resulting episode state. */
export async function checkHostedPressureCached(
  dependencies: Dependencies = {},
): Promise<HostedPressureDecision> {
  const database = dependencies.database ?? db(true)
  const clock = dependencies.clock ?? Date.now()
  const at = new Date(clock).toISOString()
  let cached: CacheRow | null = null
  let previous = CLEAR_HOSTED_PRESSURE_STATE
  let claimed = false
  claimTransaction(database, dependencies.failFastStoreClaim, () => {
    cached = database
      .query(
        'SELECT checked_at,state,last_sample,last_error FROM hosted_pressure_cache WHERE singleton=1',
      )
      .get() as CacheRow | null
    if (cached && clock - Date.parse(cached.checked_at) < HOSTED_METRICS_INTERVAL_MS) return
    previous = parseState(cached?.state ?? null)
    database
      .query(
        `INSERT INTO hosted_pressure_cache(record_id,singleton,checked_at,state,onset_at,below_since,last_sample,last_error)
       VALUES(?,1,?,?,?,?,NULL,NULL)
       ON CONFLICT(singleton) DO UPDATE SET checked_at=excluded.checked_at`,
      )
      .run(newRecordId(), at, JSON.stringify(previous), previous.onsetAt, previous.belowSince)
    claimed = true
  })
  if (!claimed) return cachedDecision(cached!)
  const observation = await observeHostedMetrics(at, {
    fetch: dependencies.fetch ?? globalThis.fetch,
    resolveToken: dependencies.resolveToken ?? readEnvValuesWithHosted,
  })
  const decision = decideHostedPressure(previous, observation)
  claimTransaction(database, dependencies.failFastStoreClaim, () => {
    const observationError = decision.conditions.find(
      (condition) => condition.kind === 'observation-error',
    )
    const failure = observationError?.detail ?? null
    database
      .query(
        `UPDATE hosted_pressure_cache
          SET state=?,onset_at=?,below_since=?,last_sample=?,last_error=?
        WHERE singleton=1 AND checked_at=?`,
      )
      .run(
        JSON.stringify(decision.state),
        decision.state.onsetAt,
        decision.state.belowSince,
        JSON.stringify(observation),
        failure,
        at,
      )
  })
  return decision
}
