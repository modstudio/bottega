// concern: recorded run liveness facts
/** Resolves the shared harness owner-session and wall-bound facts for runAlive. */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_LIVE_MS } from '../database/db.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { job, resolveJobTimeoutMs } from '../jobs/jobs.ts'

export type RecordedRunLiveness = {
  record_id?: string
  executor?: 'external' | 'harness'
  session_id?: string | null
  started_at?: string
  job?: string
}

function recordedTimeoutMinutes(recordId: string | undefined): number | undefined {
  if (!recordId) return undefined
  const path = join(resolveRunsDirectory(process.env), recordId, 'deliverables.json')
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { timeoutMinutes?: unknown }
    return typeof value.timeoutMinutes === 'number' ? value.timeoutMinutes : undefined
  } catch {
    return undefined
  }
}

export function recordedRunLivenessFacts(
  database: Database,
  row: RecordedRunLiveness,
  now = Date.now(),
): {
  executor?: 'external' | 'harness'
  ownerSessionAlive?: boolean
  wallBoundExceeded?: boolean
} {
  if (row.executor !== 'harness') return { executor: row.executor }
  const seen = row.session_id
    ? (database
        .query<{ last_seen: string }, [string]>(
          'SELECT last_seen FROM session_seen WHERE session_id=?',
        )
        .get(row.session_id) ?? null)
    : null
  const timeoutMinutes = recordedTimeoutMinutes(row.record_id)
  const wallBound = row.job
    ? resolveJobTimeoutMs(job(row.job), Number.POSITIVE_INFINITY, timeoutMinutes)
    : 0
  return {
    executor: 'harness',
    ownerSessionAlive: seen !== null && Date.parse(seen.last_seen) >= now - SESSION_LIVE_MS,
    wallBoundExceeded: !row.started_at || !row.job || now - Date.parse(row.started_at) > wallBound,
  }
}
