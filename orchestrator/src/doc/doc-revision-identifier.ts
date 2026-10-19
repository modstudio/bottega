// concern: document-revision-identity
/** Resolves a user-facing revision number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

const ACCEPTED = 'a positive decimal document-revision number or a full document-revision UUID'

export function resolveDocRevisionIdentifier(database: Database, input: string | number): string {
  const given = String(input)
  const number = /^[0-9]+$/.test(given) ? Number(given) : null
  if (number !== null && Number.isSafeInteger(number) && number > 0) {
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM doc_revision WHERE number=?')
      .get(number)
    if (row) return row.record_id
    throw new Error(`no document revision has number ${number}; pass ${ACCEPTED}`)
  }
  if (!hasRecordIdShape(given))
    throw new Error(
      `invalid document-revision identifier ${JSON.stringify(given)}: expected ${ACCEPTED}`,
    )
  const recordId = given.toLowerCase()
  if (database.query('SELECT 1 FROM doc_revision WHERE record_id=?').get(recordId)) return recordId
  throw new Error(`no document revision has UUID ${JSON.stringify(given)}; pass ${ACCEPTED}`)
}
