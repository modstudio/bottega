// concern: question-store-port
/** Defines the question persistence boundary. Callers remain on SQLite until DEV-2328. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { syncRecord } from '../record/record-sync.ts'
import type { RecordQuestionClient } from '../record/record-api-client-question.ts'
import { RecordQuestionStore } from './question-store-record.ts'
import { SqliteQuestionStore } from './question-store-sqlite.ts'
import type { QuestionStore } from './question-store-types.ts'

/** SQLite stays authoritative in every install mode for this slice. */
export function questionStore(database: Database): QuestionStore {
  return new SqliteQuestionStore(database)
}

export function recordQuestionStore(input: {
  database: Database
  client: RecordQuestionClient
  destinationSpaceId: string
  pushRun?: (runId: string) => Promise<void>
}): QuestionStore {
  return new RecordQuestionStore({
    ...input,
    pushRun:
      input.pushRun ??
      (async (runId) => {
        await syncRecord({ local: input.database })
        const synced = input.database
          .query<{ synced_at: string | null }, [string]>(
            `SELECT synced_at FROM outbox WHERE kind='run' AND row_id=? ORDER BY id DESC LIMIT 1`,
          )
          .get(runId)
        if (!synced?.synced_at)
          throw new Error(
            `run ${runId} did not reach the hosted record; run \`${PLATFORM_SLUG} record sync\`, inspect the outbox refusal, then retry`,
          )
      }),
  })
}
