// concern: root run ownership
/** Resolves the root run and project that own a descendant's resource claims. */
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'

export type RunRootRecord = { rootRunId: string; projectId: string | null }

export function runRootRecord(runId: string, database: Database = db()): RunRootRecord | null {
  const row = database
    .query<{ root_id: string; project_record_id: string | null }, [string]>(
      `SELECT COALESCE(parent_run_record_id,record_id) root_id,project_record_id
       FROM run WHERE record_id=?`,
    )
    .get(runId)
  return row ? { rootRunId: row.root_id, projectId: row.project_record_id } : null
}

export function rootRunRecordId(runId: string): string {
  const run = runRootRecord(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return run.rootRunId
}
