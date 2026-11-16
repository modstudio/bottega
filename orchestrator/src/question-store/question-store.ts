// concern: question-store-port
/** Defines the question persistence boundary. */

import type { Database } from 'bun:sqlite'
import { SqliteQuestionStore } from './question-store-sqlite.ts'
import type { QuestionStore } from './question-store-types.ts'

/** SQLite stays authoritative in every install mode for this slice. */
export function questionStore(database: Database): QuestionStore {
  return new SqliteQuestionStore(database)
}
