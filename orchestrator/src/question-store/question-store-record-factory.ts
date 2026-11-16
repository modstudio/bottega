// concern: record-question-store-factory
/** Constructs the hosted adapter without coupling the local selector to record sync. */

import type { Database } from 'bun:sqlite'
import type { RecordQuestionClient } from '../record/record-api-client-question.ts'
import { RecordQuestionStore } from './question-store-record.ts'
import type { QuestionStore } from './question-store-types.ts'

export function recordQuestionStore(input: {
  database: Database
  client: RecordQuestionClient
  pushRun?: (runId: string) => Promise<void>
}): QuestionStore {
  return new RecordQuestionStore(input)
}
