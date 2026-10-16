// concern: run-terminal-outbox
/** Keeps a post-terminal artifact error and the records it changes in one transaction. */
import type { Database } from 'bun:sqlite'
import { writeTransaction } from '../database/db.ts'
import { rollUpRootAndEnqueue } from './run-liveness.ts'
import { enqueueRunRecord } from './run-outbox.ts'

export function recordArtifactPersistenceFailure(
  database: Database,
  input: {
    runId: number
    parentRunId: number | null
    error: string | null
    machineId: string
    finishedAt: string
  },
): void {
  writeTransaction(() => {
    database
      .query(
        `UPDATE run SET
           error=CASE WHEN status='stopped' THEN error ELSE ? END
         WHERE id=?`,
      )
      .run(input.error, input.runId)
    enqueueRunRecord(database, input.runId, input.machineId, input.finishedAt)
    if (input.parentRunId !== null) {
      rollUpRootAndEnqueue(database, input.parentRunId, input.machineId, input.finishedAt)
    }
  }, database)
}
