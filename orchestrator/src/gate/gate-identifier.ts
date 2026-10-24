// concern: worker gate
/** Resolves a user-facing gate number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

type ParsedGateIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_GATE_IDENTIFIERS = 'a positive decimal gate number or a full gate UUID'

function parseGateIdentifier(input: string | number): ParsedGateIdentifier {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid gate identifier ${JSON.stringify(given)}: expected ${ACCEPTED_GATE_IDENTIFIERS}`,
  )
}

export function resolveGateIdentifier(database: Database, input: string | number): string {
  const parsed = parseGateIdentifier(input)
  if (parsed.kind === 'number') {
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM gate_execution WHERE number=?')
      .get(parsed.number)
    if (row) return row.record_id
    throw new Error(`no gate has number ${parsed.number}; pass ${ACCEPTED_GATE_IDENTIFIERS}`)
  }
  const row = database
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM gate_execution WHERE record_id=?',
    )
    .get(parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no gate has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_GATE_IDENTIFIERS}`,
  )
}
