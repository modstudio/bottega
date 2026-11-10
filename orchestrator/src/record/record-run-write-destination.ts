// concern: record-run-write-destination
/** Resolves an id-addressed run write through the run's registered project. */

import { db } from '../database/db.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordRequestDestination } from './record-api-client-paths.ts'
import { recordWriteDestination } from './record-write-destination.ts'

export async function recordRunWriteDestination(
  client: RecordApiClient,
  runId: string,
): Promise<RecordRequestDestination> {
  const row = db()
    .query<{ project: string }, [string]>(
      `SELECT project.name project
       FROM run JOIN project ON project.record_id=run.project_record_id
       WHERE run.record_id=?`,
    )
    .get(runId)
  return recordWriteDestination(client, row ? { kind: 'project', name: row.project } : null)
}
