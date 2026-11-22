// concern: record-read-authority
/** Applies shared-state read authority at the hosted-record boundary. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { decideRecordRead, type RecordReadDecision } from './record-read-decision.ts'
import { currentRecordAuthorityFacts, throwIfRecordRefused } from './record-write-authority.ts'

function currentRecordReadDecision(
  database: Database = db(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RecordReadDecision {
  return decideRecordRead(currentRecordAuthorityFacts(database, environment))
}

export function applyRecordReadAuthority<T>(
  actions: { local(): T | Promise<T>; hosted(): T | Promise<T> },
  database: Database = db(),
): Promise<T> {
  const decision = currentRecordReadDecision(database)
  throwIfRecordRefused(decision)
  return Promise.resolve(
    decision.verdict === 'local-authoritative' ? actions.local() : actions.hosted(),
  )
}
