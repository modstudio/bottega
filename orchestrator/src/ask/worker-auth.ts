import { db } from '../database/db.ts'

/** The single authentication check for tools acting as an orch worker. */
export function authenticatedWorkerRun(runId: number, token: string): boolean {
  if (!runId) return false
  const row = db().query('SELECT run_token FROM run WHERE id = ?').get(runId) as {
    run_token: string | null
  } | null
  if (!row) return false
  // A run recorded before tokens existed has none; those still work, because
  // refusing them would break every in-flight worker on upgrade.
  return !row.run_token || row.run_token === token
}

/** Authentication for worker actions that write outside the orchestrator. */
export function strictlyAuthenticatedWorkerRun(runId: number, token: string): boolean {
  if (!runId) return false
  const row = db().query('SELECT run_token FROM run WHERE id = ?').get(runId) as {
    run_token: string | null
  } | null
  return row !== null && row.run_token !== null && row.run_token === token
}
