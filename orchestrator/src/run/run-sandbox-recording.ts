// concern: recording the sandbox dispatch decision on its run row

import type { Database } from 'bun:sqlite'
import { sandboxReasonPrefix } from '../sandbox/sandbox.ts'

/** Persist the dedicated sandbox reason while preserving existing route-reason rendering. */
export function recordRunSandboxSelection(
  database: Database,
  runId: string,
  selection: { sandbox: 'host' | 'srt'; reason: string | null; routeReason: string },
): void {
  const routeReason = selection.reason
    ? `${selection.routeReason}; ${sandboxReasonPrefix(selection.sandbox)}: ${selection.reason}`
    : selection.routeReason
  database
    .query('UPDATE run SET sandbox=?, sandbox_reason=?, route_reason=? WHERE record_id=?')
    .run(selection.sandbox, selection.reason, routeReason, runId)
}
