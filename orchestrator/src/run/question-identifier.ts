// concern: run-control
/** Resolves a user-facing question number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import type { QuestionIdentity } from '../../../shared/orch-contract.ts'
import { parseReference, REFERENCE_PREFIXES } from '../../../shared/reference.ts'
import { resolve } from '../identity/identity.ts'
import { identityContext } from '../identity/identity-context.ts'
import { questionById } from '../question-store/question-store-read.ts'

export type ParsedQuestionIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

export async function questionIdentityMap(
  database: Database,
  identifiers: Array<string | number>,
): Promise<QuestionIdentity[]> {
  return Promise.all(
    identifiers.map(async (identifier) => {
      const recordId = await resolveQuestionIdentifier(database, identifier)
      const row = await questionById(database, recordId)
      if (!row) throw new Error(`no question has identifier ${JSON.stringify(String(identifier))}`)
      return { number: Number(row.number), record_id: String(row.record_id) }
    }),
  )
}

export function parseQuestionIdentifier(input: string | number): ParsedQuestionIdentifier {
  let parsed: ReturnType<typeof parseReference>
  try {
    parsed = parseReference(input, 'question')
  } catch {
    throw new Error(
      `invalid question identifier ${JSON.stringify(String(input))}: expected a q-prefixed question number, positive decimal question number, or full question UUID`,
    )
  }
  if (parsed.value.kind === 'record-id')
    return { kind: 'record-id', recordId: parsed.value.recordId }
  if (parsed.value.kind === 'number') return { kind: 'number', id: parsed.value.number }
  if (parsed.value.kind === 'label' && parsed.value.prefix === REFERENCE_PREFIXES.question)
    return { kind: 'number', id: parsed.value.number }
  throw new Error(`reference ${JSON.stringify(String(input))} does not name a question`)
}

export async function resolveQuestionIdentifier(
  database: Database,
  input: string | number,
): Promise<string> {
  return (await resolve(input, identityContext(database), 'question')).recordId
}
