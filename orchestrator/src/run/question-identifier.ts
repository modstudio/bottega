// concern: run-control
/** Resolves a user-facing question number or UUID to this machine's local row id. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type ParsedQuestionIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_QUESTION_IDENTIFIERS = 'a positive decimal question number or a full question UUID'

export function parseQuestionIdentifier(input: string | number): ParsedQuestionIdentifier {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const id = Number(given)
    if (Number.isSafeInteger(id) && id > 0) return { kind: 'number', id }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid question identifier ${JSON.stringify(given)}: expected ${ACCEPTED_QUESTION_IDENTIFIERS}`,
  )
}

export function resolveQuestionIdentifier(database: Database, input: string | number): number {
  const parsed = parseQuestionIdentifier(input)
  if (parsed.kind === 'number') return parsed.id
  const row = database
    .query<{ id: number }, [string]>('SELECT id FROM question WHERE record_id=?')
    .get(parsed.recordId)
  if (row) return row.id
  throw new Error(
    `no question has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_QUESTION_IDENTIFIERS}`,
  )
}
