// concern: route
/** Reads the live, non-probe runs behind routing capacity admission and the run-throttle concurrency fact. */
import type { Database } from 'bun:sqlite'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { db } from '../database/db.ts'

export type RunningRunsByAgent = Map<string, string[]>
export type RunningRunCounts = Record<string, number>

/**
 * The live-run predicate both queries share. The capacity waiter compares a
 * snapshot's counts with fresh counts, so the two must define live identically.
 */
const LIVE_RUN = "status='running' AND probe=0"

/** One routing-pass snapshot, grouped without issuing a query per registry row. */
export function runningRunsByAgent(database: Database = db()): RunningRunsByAgent {
  const rows = database
    .query(`SELECT agent, record_id FROM run WHERE ${LIVE_RUN} ORDER BY number`)
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
        WHERE ${LIVE_RUN} AND agent IN (${placeholders})
        GROUP BY agent`,
    )
    .all(...uniqueAgents) as { agent: string; running: number }[]
  const counts: RunningRunCounts = Object.fromEntries(uniqueAgents.map((agent) => [agent, 0]))
  for (const row of rows) counts[row.agent] = row.running
  return counts
}

/** All live runs sharing one worker harness, including separately named agent rows. */
export function runningRunCountForHarness(harness: string, database: Database = db()): number {
  const rows = database
    .query(
      `SELECT r.agent name, a.harness FROM run r LEFT JOIN agent a ON a.name=r.agent
        WHERE ${LIVE_RUN}`,
    )
    .all() as { name: string; harness: string | null }[]
  return rows.filter(
    (row) => workerHarnessName({ ...row, harness: row.harness ?? undefined }) === harness,
  ).length
}
