// concern: question-store-port
/** Defines the question persistence boundary. */

import type { Database } from 'bun:sqlite'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { RecordQuestionStore } from './question-store-record.ts'
import { SqliteQuestionStore } from './question-store-sqlite.ts'
import type { QuestionStore } from './question-store-types.ts'

export function questionStore(database: Database): QuestionStore {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  return decision.verdict === 'hosted'
    ? new RecordQuestionStore({ database, client: recordApiClient() })
    : new SqliteQuestionStore(database)
}
