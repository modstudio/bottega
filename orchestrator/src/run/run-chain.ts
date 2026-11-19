// concern: run-chain
/** Knows chain membership order and when a chain's terminal outcome became observable. */

import type { Database } from 'bun:sqlite'
import { TERMINAL_RUN_STATUS_SET } from './run-status.ts'

/** One definition of the member whose status and process represent a conversation now. */
export function currentRunMemberJoin(rootAlias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(rootAlias)) throw new Error('invalid run query alias')
  return `JOIN run current_run ON current_run.record_id = (
    SELECT member.record_id FROM run member
     WHERE member.record_id = ${rootAlias}.record_id OR member.parent_run_record_id = ${rootAlias}.record_id
     ORDER BY member.turn DESC, member.number DESC LIMIT 1
  )`
}

export const CURRENT_RUN_MEMBER_JOIN_SQL = currentRunMemberJoin('root')

export function runChainIds(database: Database, rootId: string): string[] {
  return database
    .query<{ record_id: string }, [string, string]>(
      'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number',
    )
    .all(rootId, rootId)
    .map(({ record_id }) => record_id)
}

export function chainTerminationAtForRoot(database: Database, rootId: string): string | null {
  const terminal = database
    .query(
      `SELECT started_at, latency_ms, status FROM run
      WHERE record_id=? OR parent_run_record_id=?
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { started_at: string; latency_ms: number | null; status: string } | null
  if (!terminal || !TERMINAL_RUN_STATUS_SET.has(terminal.status) || terminal.latency_ms === null) {
    return null
  }
  return new Date(Date.parse(terminal.started_at) + terminal.latency_ms).toISOString()
}
