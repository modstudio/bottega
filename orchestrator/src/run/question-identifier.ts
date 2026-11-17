// concern: run-control
/** Resolves a user-facing question number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import type { QuestionIdentity } from '../../../shared/orch-contract.ts'
import { parseReference } from '../../../shared/reference.ts'
import { resolve } from '../identity/identity.ts'
import { identityContext } from '../identity/identity-context.ts'

export type ParsedQuestionIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

export async function questionIdentityMap(
  database: Database,
  identifiers: Array<string | number>,
): Promise<QuestionIdentity[]> {
  const context = identityContext(database)
  return Promise.all(
    identifiers.map(async (identifier) => {
      const resolved = await resolve(identifier, context, 'question')
      const row = database
        .query<{ number: number }, [string]>('SELECT number FROM question WHERE record_id=?')
        .get(resolved.recordId)
      if (!row) throw new Error(`question ${resolved.recordId} is not cached locally`)
      return { number: row.number, record_id: resolved.recordId }
    }),
  )
}

export function parseQuestionIdentifier(input: string | number): ParsedQuestionIdentifier {
  const parsed = parseReference(input, 'question')
  if (parsed.value.kind === 'record-id')
    return { kind: 'record-id', recordId: parsed.value.recordId }
  if (parsed.value.kind === 'number') return { kind: 'number', id: parsed.value.number }
  if (parsed.value.kind === 'label' && parsed.value.prefix === 'q')
    return { kind: 'number', id: parsed.value.number }
  throw new Error(`reference ${JSON.stringify(String(input))} does not name a question`)
}

export async function resolveQuestionIdentifier(
  database: Database,
  input: string | number,
): Promise<string> {
  return (await resolve(input, identityContext(database), 'question')).recordId
}
