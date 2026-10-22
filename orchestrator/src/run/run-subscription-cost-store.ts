// concern: run-subscription-cost-store
/** Loads the agent and month-token facts the subscription cost reader needs. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { SubscriptionCostFacts } from './run-subscription-cost.ts'

export function subscriptionCostFacts(database: Database = db()): SubscriptionCostFacts {
  const agents = Object.fromEntries(
    (
      database.query('SELECT name, billing, harness FROM agent').all() as {
        name: string
        billing: string
        harness: string
      }[]
    ).map((row) => [row.name, { billing: row.billing, harness: row.harness }]),
  )
  const monthTokens: Record<string, number> = {}
  for (const row of database
    .query(
      `SELECT a.harness AS harness, substr(r.started_at, 1, 7) AS month,
              COALESCE(SUM(r.vendor_tokens), 0) AS tokens
         FROM run r
         JOIN agent a ON a.name = r.agent
        WHERE a.billing = 'subscription'
        GROUP BY a.harness, substr(r.started_at, 1, 7)`,
    )
    .all() as { harness: string; month: string; tokens: number }[]) {
    monthTokens[`${row.harness}:${row.month}`] = Number(row.tokens)
  }
  return { agents, monthTokens }
}
