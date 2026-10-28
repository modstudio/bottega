// concern: route
/** Reads operational failures that temporarily suppress an agent from routing. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { COOLS_DOWN } from '../failure/failure.ts'

export type CoolingFailure = {
  agent: string
  failure_kind: string
  mins_ago: number
}

const PROVIDER_ERROR_STREAK = 3

export type RecentTerminalRun = {
  agent: string
  status: string
  failure_kind: string | null
  mins_ago: number
}

/** Repeated provider errors cool only when they are the agent's uninterrupted latest streak. */
export function providerErrorStreakCooling(
  rows: readonly RecentTerminalRun[],
): CoolingFailure | null {
  if (rows.length < PROVIDER_ERROR_STREAK) return null
  const recent = rows.slice(0, PROVIDER_ERROR_STREAK)
  if (!recent.every((row) => row.status === 'failed' && row.failure_kind === 'provider_error'))
    return null
  return {
    agent: recent[0]!.agent,
    failure_kind: 'provider_error',
    mins_ago: recent[0]!.mins_ago,
  }
}

const coolsDownSql = () => COOLS_DOWN.map((kind) => `'${kind}'`).join(',')

export function coolingFailures(d: Database, cooldownMinutes: number): Map<string, CoolingFailure> {
  const rows = d
    .query(
      `WITH terminal AS (
         SELECT record_id, agent, status, failure_kind,
                julianday(started_at) + latency_ms / 86400000.0 AS finished_at
           FROM run
          WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL
            AND job NOT LIKE 'agent-probe-%'
       ), cooling_failures AS (
         SELECT record_id, agent, failure_kind, finished_at,
                ROW_NUMBER() OVER (
                  PARTITION BY agent ORDER BY finished_at DESC, record_id DESC
                ) AS recency
           FROM terminal
          WHERE status = 'failed' AND failure_kind IN (${coolsDownSql()})
       )
       SELECT f.agent, f.failure_kind,
              (julianday('now') - f.finished_at) * 1440 AS mins_ago
         FROM cooling_failures f
        WHERE f.recency = 1
          AND (
            (julianday('now') - f.finished_at) * 1440 < ? OR
            (f.failure_kind = 'daily_quota' AND date(f.finished_at) = date('now'))
          )
          AND NOT EXISTS (
                SELECT 1 FROM terminal s
                 WHERE s.agent = f.agent AND s.status = 'ok'
                   AND s.finished_at > f.finished_at
              )`,
    )
    .all(cooldownMinutes) as CoolingFailure[]
  const result = new Map(rows.map((row) => [row.agent, row]))
  const recentRows = d
    .query(
      `WITH terminal AS (
         SELECT record_id,agent,status,failure_kind,
                (julianday('now') - (julianday(started_at) + latency_ms / 86400000.0)) * 1440 AS mins_ago,
                ROW_NUMBER() OVER (
                  PARTITION BY agent
                  ORDER BY julianday(started_at) + latency_ms / 86400000.0 DESC, record_id DESC
                ) AS recency
           FROM run
          WHERE status IN ('ok','failed') AND latency_ms IS NOT NULL
            AND job NOT LIKE 'agent-probe-%'
       )
       SELECT agent,status,failure_kind,mins_ago
         FROM terminal
        WHERE recency <= ?
        ORDER BY agent,recency`,
    )
    .all(PROVIDER_ERROR_STREAK) as RecentTerminalRun[]
  const byAgent = new Map<string, RecentTerminalRun[]>()
  for (const row of recentRows) byAgent.set(row.agent, [...(byAgent.get(row.agent) ?? []), row])
  for (const agentRows of byAgent.values()) {
    const failure = providerErrorStreakCooling(agentRows)
    if (failure && failure.mins_ago < cooldownMinutes) result.set(failure.agent, failure)
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
