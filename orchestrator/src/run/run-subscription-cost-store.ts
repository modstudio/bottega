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
  const windows = new Map<string, SubscriptionQuotaWindow>()
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
    if (
      row.quotaStart !== null &&
      row.quotaEnd !== null &&
      row.windowMinutes !== null &&
      row.resetsAt !== null
    ) {
      const windowKey = `${row.harness}:${row.resetsAt}`
      const prior = windows.get(windowKey)
      windows.set(windowKey, {
        harness: row.harness,
        resetsAt: row.resetsAt,
        windowMinutes: row.windowMinutes,
        usedPercentStart: Math.min(prior?.usedPercentStart ?? row.quotaStart, row.quotaStart),
        usedPercentEnd: Math.max(prior?.usedPercentEnd ?? row.quotaEnd, row.quotaEnd),
        tokens: (prior?.tokens ?? 0) + Number(row.tokens ?? 0),
      })
    }
  }
  return { agents, monthTokens, quotaWindows: [...windows.values()] }
}
