// concern: hosted-board-presence
/** Selects the live presence owned by the checkout project being refreshed. */

import type { Database } from 'bun:sqlite'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { projectAt } from '../project/projects.ts'
import type { HostedBoardPresenceInput } from '../record/record-board-contract.ts'

export function hostedBoardPresence(
  database: Database,
  cwd: string,
  at: number,
): HostedBoardPresenceInput[] {
  const checkoutProject = projectAt(cwd, database)
  if (!checkoutProject) return []
  const liveSince = new Date(at - SESSION_LIVE_MS).toISOString()
  return database
    .query(
      `SELECT session_id AS session,project_record_id AS projectId,role,
              COALESCE(first_seen,last_seen) AS firstSeen,last_seen AS lastSeen
       FROM presence WHERE last_seen>=? AND project_record_id=?`,
    )
    .all(liveSince, checkoutProject.recordId) as HostedBoardPresenceInput[]
}
