// concern: route
/** Reads the live, non-probe runs used by routing capacity admission. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'

export type RunningRunsByAgent = Map<string, string[]>
export type RunningRunCounts = Record<string, number>

/** One routing-pass snapshot, grouped without issuing a query per registry row. */
export function runningRunsByAgent(database: Database = db()): RunningRunsByAgent {
  const rows = database
    .query("SELECT agent, record_id FROM run WHERE status='running' AND probe=0 ORDER BY number")
    .all() as { agent: string; record_id: string }[]
  const grouped: RunningRunsByAgent = new Map()
  for (const row of rows) {
    const runs = grouped.get(row.agent)
    if (runs) runs.push(row.record_id)
    else grouped.set(row.agent, [row.record_id])
  }
  return grouped
}

/** One indexed fact query for a capacity waiter; absent agents have zero live runs. */
export function runningRunCountsForAgents(
  agents: readonly string[],
  database: Database = db(),
): RunningRunCounts {
  const uniqueAgents = [...new Set(agents)]
  if (!uniqueAgents.length) return {}
  const placeholders = uniqueAgents.map(() => '?').join(',')
  const rows = database
    .query(
      `SELECT agent, COUNT(*) AS running FROM run
        WHERE status='running' AND probe=0 AND agent IN (${placeholders})
        GROUP BY agent`,
    )
    .all(...uniqueAgents) as { agent: string; running: number }[]
  const counts: RunningRunCounts = Object.fromEntries(uniqueAgents.map((agent) => [agent, 0]))
  for (const row of rows) counts[row.agent] = row.running
  return counts
}

export function runningRunCountForAgent(agent: string): number {
  return runningRunCountsForAgents([agent])[agent] ?? 0
}
