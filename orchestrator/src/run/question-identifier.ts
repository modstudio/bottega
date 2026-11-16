// concern: run-control
/** Resolves a user-facing question number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import type { QuestionIdentity } from '../../../shared/orch-contract.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { questionById } from '../question-store/question-store-mutation.ts'
import { questionRulings } from '../question-store/question-store-read.ts'

export type ParsedQuestionIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_QUESTION_IDENTIFIERS = 'a positive decimal question number or a full question UUID'

export async function questionIdentityMap(database: Database): Promise<QuestionIdentity[]> {
  const { items } = await questionRulings(database, { kind: 'all' })
  return items.map((row) => ({ number: Number(row.number), record_id: String(row.record_id) }))
}

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

export async function resolveQuestionIdentifier(database: Database, input: string | number): Promise<string> {
  const parsed = parseQuestionIdentifier(input)
  if (parsed.kind === 'number') {
    const row = (await questionIdentityMap(database)).find(({ number }) => number === parsed.id)
    if (row) return row.record_id
    throw new Error(`no question has number ${parsed.id}; pass ${ACCEPTED_QUESTION_IDENTIFIERS}`)
  }
  const row = await questionById(database, parsed.recordId)
  if (row) return parsed.recordId
  throw new Error(
    `no question has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_QUESTION_IDENTIFIERS}`,
  )
}
