// concern: question-store-port
/** Defines the question persistence boundary. */

import type { Database } from 'bun:sqlite'
import { recordApiClient, recordApiClientInjected } from '../record/record-api-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { RecordQuestionStore } from './question-store-record.ts'
import { SqliteQuestionStore } from './question-store-sqlite.ts'
import type { QuestionStore } from './question-store-types.ts'

/**
 * How long one process reuses a hosted store, and with it the identity and
 * space list that store has already read. Every hosted read otherwise starts
 * with a fresh identity read and fans out to every member space.
 */
const HOSTED_QUESTION_STORE_REUSE_MS = 5 * 60_000

const hostedStores = new WeakMap<Database, { store: RecordQuestionStore; at: number }>()

export function questionStore(database: Database): QuestionStore {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  if (decision.verdict !== 'hosted') return new SqliteQuestionStore(database)
  // An injected client is a test seam that changes between tests; never reuse across it.
  if (recordApiClientInjected())
    return new RecordQuestionStore({ database, client: recordApiClient() })
  const now = Date.now()
  const reused = hostedStores.get(database)
  if (reused && now - reused.at < HOSTED_QUESTION_STORE_REUSE_MS) return reused.store
  const store = new RecordQuestionStore({ database, client: recordApiClient() })
  hostedStores.set(database, { store, at: now })
  return store
}
