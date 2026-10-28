// concern: route
/** Reads and decides operational failures that temporarily suppress agents from routing. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { COOLS_DOWN, FAILURE_KINDS, type FailureKind } from '../failure/failure.ts'

export type CoolingFailure = {
  agent: string
  failure_kind: string
  mins_ago: number
}

const PROVIDER_ERROR_STREAK = 3

export type RecentTerminalRun = {
  record_id: string
  number: number
  agent: string
  job: string
  status: string
  failure_kind: string | null
  endpoint_key_source: 'agent' | 'project' | null
  finished_at: number
  mins_ago: number
}

type StoredTerminalRun = Omit<RecentTerminalRun, 'finished_at' | 'mins_ago'> & {
  started_at: string
  latency_ms: number
}

/**
 * One bounded availability read for a routing pass. The partial index makes each
 * correlated lookup proportional to the registered agent count, not run history.
 */
export function recentTerminalRuns(
  database: Database,
  agentNames: readonly string[],
  now = Date.now(),
): RecentTerminalRun[] {
  if (agentNames.length === 0) return []
  const failureKinds = [null, ...FAILURE_KINDS]
  const names = JSON.stringify(agentNames)
  const rows = database
    .query(
      `WITH categories(status,failure_kind) AS (
         SELECT statuses.value,kinds.value
           FROM json_each(?) statuses CROSS JOIN json_each(?) kinds
       ), selected(record_id) AS (
         SELECT (
           SELECT categorized.record_id
             FROM run categorized
            WHERE categorized.agent=names.value
              AND categorized.status=categories.status
              AND categorized.status IN ('ok','failed')
              AND categorized.failure_kind IS categories.failure_kind
              AND categorized.latency_ms IS NOT NULL
            ORDER BY julianday(categorized.started_at) + categorized.latency_ms / 86400000.0 DESC,
                     categorized.record_id DESC
            LIMIT 1
         )
           FROM json_each(?) names CROSS JOIN categories
         UNION
         SELECT recent.record_id
           FROM json_each(?) names
           JOIN run recent ON recent.record_id IN (
             SELECT streak.record_id
               FROM run streak
              WHERE streak.agent=names.value
                AND streak.status IN ('ok','failed')
                AND streak.latency_ms IS NOT NULL
              ORDER BY julianday(streak.started_at) + streak.latency_ms / 86400000.0 DESC,
                       streak.record_id DESC
              LIMIT ?
           )
       )
       SELECT r.record_id,r.number,r.agent,r.job,r.status,r.failure_kind,r.endpoint_key_source,
              r.started_at,r.latency_ms
         FROM selected JOIN run r USING(record_id)`,
    )
    .all(
      JSON.stringify(['ok', 'failed']),
      JSON.stringify(failureKinds),
      names,
      names,
      PROVIDER_ERROR_STREAK,
    ) as StoredTerminalRun[]
  return rows.map(({ started_at, latency_ms, ...row }) => {
    const finishedAt = Date.parse(started_at) + latency_ms
    return { ...row, finished_at: finishedAt, mins_ago: (now - finishedAt) / 60_000 }
  })
}

function newestFirst(rows: readonly RecentTerminalRun[]): RecentTerminalRun[] {
  return [...rows].sort(
    (left, right) =>
      right.finished_at - left.finished_at || right.record_id.localeCompare(left.record_id),
  )
}

/** Repeated provider errors cool only when they are the agent's uninterrupted latest streak. */
export function providerErrorStreakCooling(
  rows: readonly RecentTerminalRun[],
): CoolingFailure | null {
  if (rows.length < PROVIDER_ERROR_STREAK) return null
  const recent = newestFirst(rows).slice(0, PROVIDER_ERROR_STREAK)
  if (!recent.every((row) => row.status === 'failed' && row.failure_kind === 'provider_error'))
    return null
  return {
    agent: recent[0]!.agent,
    failure_kind: 'provider_error',
    mins_ago: recent[0]!.mins_ago,
  }
}

function sameUtcDay(timestamp: number, now: number): boolean {
  return new Date(timestamp).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
}

/** Decide ordinary cooldowns and provider-error streaks from one bounded store read. */
export function decideCoolingFailures(
  rows: readonly RecentTerminalRun[],
  cooldownMinutes: number,
  now = Date.now(),
): Map<string, CoolingFailure> {
  const byAgent = new Map<string, RecentTerminalRun[]>()
  for (const row of rows) byAgent.set(row.agent, [...(byAgent.get(row.agent) ?? []), row])
  const result = new Map<string, CoolingFailure>()
  for (const [agent, agentRows] of byAgent) {
    const ordered = newestFirst(agentRows)
    const latestAvailability = ordered.find(
      (row) =>
        !row.job.startsWith('agent-probe-') &&
        (row.status === 'ok' ||
          (row.failure_kind !== null && COOLS_DOWN.includes(row.failure_kind as FailureKind))),
    )
    if (latestAvailability?.status === 'failed') {
      const active =
        latestAvailability.failure_kind === 'daily_quota'
          ? sameUtcDay(latestAvailability.finished_at, now)
          : latestAvailability.mins_ago < cooldownMinutes
      if (active) {
        result.set(agent, {
          agent,
          failure_kind: latestAvailability.failure_kind!,
          mins_ago: latestAvailability.mins_ago,
        })
      }
    }
    const streak = providerErrorStreakCooling(ordered)
    if (streak && streak.mins_ago < cooldownMinutes) result.set(agent, streak)
  }
  return result
}

export function coolingRefusal(
  agent: string,
  failure: CoolingFailure,
  cooldownMinutes: number,
): string {
  const cooling = coolingPhrase(failure)
  const retry =
    failure.failure_kind === 'daily_quota' ? 'after the next UTC day' : `after ${cooldownMinutes}m`
  return (
    `vendor ${cooling}; retry ${retry} ` +
    `or run '${PLATFORM_SLUG} agent probe ${agent}' to clear it`
  )
}

export function coolingPhrase(failure: Pick<CoolingFailure, 'failure_kind' | 'mins_ago'>): string {
  return `${failure.failure_kind} ${Math.round(failure.mins_ago)}m ago`
}
