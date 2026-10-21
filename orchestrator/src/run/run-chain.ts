// concern: run-chain
/** Knows chain membership order and when a chain's terminal outcome became observable. */
import type { Database } from 'bun:sqlite'

export function chainTerminationAtForRoot(database: Database, rootId: string): string | null {
  const terminal = database
    .query(
      `SELECT started_at, latency_ms, status FROM run
      WHERE record_id=? OR parent_run_record_id=?
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { started_at: string; latency_ms: number | null; status: string } | null
  if (
    !terminal ||
    !['ok', 'failed', 'stale', 'stopped'].includes(terminal.status) ||
    terminal.latency_ms === null
  ) {
    return null
  }
  return new Date(Date.parse(terminal.started_at) + terminal.latency_ms).toISOString()
}
