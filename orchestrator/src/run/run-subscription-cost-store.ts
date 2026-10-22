// concern: run-subscription-cost-store
/** Loads the agent and month-token facts the subscription cost reader needs. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import {
  type AgentBilling,
  type SubscriptionCostFacts,
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
  for (const row of database
    .query(
      `SELECT a.harness AS harness, r.started_at AS started_at, r.vendor_tokens AS tokens
         FROM run r
         JOIN agent a ON a.name = r.agent
        WHERE a.billing = 'subscription'`,
    )
    .all() as { harness: string; started_at: string; tokens: number | null }[]) {
    const key = subscriptionMonthTokenKey(row.harness, row.started_at)
    monthTokens[key] = (monthTokens[key] ?? 0) + Number(row.tokens ?? 0)
  }
  return { agents, monthTokens }
}
