// concern: run-subscription-cost-store
/** Loads the agent and month-token facts the subscription cost reader needs. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import {
  type AgentBilling,
  type SubscriptionCostFacts,
  type SubscriptionQuotaWindow,
  subscriptionMonthTokenKey,
} from './run-subscription-cost.ts'

/** Shared quota-window aggregation used by pricing and subscription pacing. */
export const SUBSCRIPTION_QUOTA_WINDOWS_SQL = `
  SELECT a.harness AS harness, r.quota_resets_at AS resetsAt,
         MAX(r.quota_window_minutes) AS windowMinutes,
         MIN(r.quota_used_percent_start) AS usedPercentStart,
         MAX(r.quota_used_percent_end) AS usedPercentEnd,
         SUM(COALESCE(r.vendor_tokens, 0)) AS tokens
    FROM run r JOIN agent a ON a.name = r.agent
   WHERE a.billing = 'subscription'
     AND r.quota_used_percent_start IS NOT NULL
     AND r.quota_used_percent_end IS NOT NULL
     AND r.quota_window_minutes IS NOT NULL
     AND r.quota_resets_at IS NOT NULL
   GROUP BY a.harness, r.quota_resets_at`

export function subscriptionCostFacts(database: Database = db()): SubscriptionCostFacts {
  const agents = Object.fromEntries(
    (
      database.query('SELECT name, billing, harness FROM agent').all() as {
        name: string
        billing: AgentBilling
        harness: string
      }[]
    ).map((row) => [row.name, { billing: row.billing, harness: row.harness }]),
  )
  const monthTokens: Record<string, number> = {}
  for (const row of database
    .query(
      `SELECT a.harness AS harness, r.started_at AS started_at, r.vendor_tokens AS tokens,
              r.quota_used_percent_start AS quotaStart, r.quota_used_percent_end AS quotaEnd,
              r.quota_window_minutes AS windowMinutes, r.quota_resets_at AS resetsAt
         FROM run r
         JOIN agent a ON a.name = r.agent
        WHERE a.billing = 'subscription'`,
    )
    .all() as Array<{
    harness: string
    started_at: string
    tokens: number | null
    quotaStart: number | null
    quotaEnd: number | null
    windowMinutes: number | null
    resetsAt: number | null
  }>) {
    const key = subscriptionMonthTokenKey(row.harness, row.started_at)
    monthTokens[key] = (monthTokens[key] ?? 0) + Number(row.tokens ?? 0)
  }
  const quotaWindows = database
    .query(SUBSCRIPTION_QUOTA_WINDOWS_SQL)
    .all() as SubscriptionQuotaWindow[]
  return { agents, monthTokens, quotaWindows }
}
