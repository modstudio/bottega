// concern: terminal lifecycle store
/** Reads the stored lifecycle fields needed to protect an architect verdict at write time. */

import type { Database } from 'bun:sqlite'
import {
  type StoredTerminalLifecycle,
  terminalLifecycleForWrite,
} from './run-terminal-lifecycle-verdict.ts'

/** Resolve incoming lifecycle fields against the verdict currently stored in the write transaction. */
export function terminalLifecycleWrite(
  database: Database,
  runId: string,
  status: string,
  error: string | null,
  failureKind: string | null,
): StoredTerminalLifecycle {
  const stored = database
    .query('SELECT status, error, failure_kind FROM run WHERE record_id=?')
    .get(runId) as { status: string; error: string | null; failure_kind: string | null }
  return terminalLifecycleForWrite(
    { status: stored.status, error: stored.error, failureKind: stored.failure_kind },
    { status, error, failureKind },
  )
}
