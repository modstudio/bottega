// concern: cursorless run evidence
/** Reads first-turn jobs that have neither a task key nor a workflow cursor binding. */

import type { Database } from 'bun:sqlite'
import { JOBS } from '../jobs/jobs.ts'

export type CursorlessRunEvidence = {
  number: number
  job: string
  session: string | null
  at: string
}

export function cursorlessRunEvidence(database: Database, from: string): CursorlessRunEvidence[] {
  return database
    .query<CursorlessRunEvidence, [string]>(
      `SELECT number,job,session_id session,started_at at
         FROM run
        WHERE launch_key IS NULL
          AND cursor_record_id IS NULL
          AND COALESCE(turn,1)=1
          AND started_at>=?
        ORDER BY number`,
    )
    .all(from)
    .filter((run) => Object.hasOwn(JOBS, run.job))
}
