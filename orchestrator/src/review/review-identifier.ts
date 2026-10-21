// concern: review-identity
/** Resolves a user-facing review number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

type ParsedReviewIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_REVIEW_IDENTIFIERS = 'a positive decimal review number or a full review UUID'

function parseReviewIdentifier(input: string | number): ParsedReviewIdentifier {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid review identifier ${JSON.stringify(given)}: expected ${ACCEPTED_REVIEW_IDENTIFIERS}`,
  )
}

export function resolveReviewIdentifier(database: Database, input: string | number): string {
  const parsed = parseReviewIdentifier(input)
  if (parsed.kind === 'number') {
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM review WHERE number=?')
      .get(parsed.number)
    if (row) return row.record_id
    throw new Error(`no review has number ${parsed.number}; pass ${ACCEPTED_REVIEW_IDENTIFIERS}`)
  }
  const row = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM review WHERE record_id=?')
    .get(parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no review has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_REVIEW_IDENTIFIERS}`,
  )
}
