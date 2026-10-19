// concern: run-control
/** Resolves a user-facing run number or UUID to the run UUID. */

import type { Database } from 'bun:sqlite'
import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type ParsedRunIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_RUN_IDENTIFIERS = 'a positive decimal run number or a full run UUID'

export function classifyRunIdentifier(input: string | number): ParsedRunIdentifier | null {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  return null
}

export function parseRunIdentifier(input: string | number): ParsedRunIdentifier {
  const given = String(input)
  const parsed = classifyRunIdentifier(input)
  if (parsed) return parsed
  throw new Error(
    `invalid run identifier ${JSON.stringify(given)}: expected ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}

export function resolveRunIdentifier(database: Database, input: string | number): string {
  const parsed = parseRunIdentifier(input)
  const row = database
    .query<{ record_id: string }, [number | string]>(
      parsed.kind === 'number'
        ? 'SELECT record_id FROM run WHERE number=?'
        : 'SELECT record_id FROM run WHERE record_id=?',
    )
    .get(parsed.kind === 'number' ? parsed.number : parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no run matches ${JSON.stringify(String(input))}; pass ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}

export function resolveRunIdentifierOrNull(
  database: Database,
  input: string | number,
): string | null {
  const parsed = classifyRunIdentifier(input)
  if (!parsed) return null
  return (
    database
      .query<{ record_id: string }, [number | string]>(
        parsed.kind === 'number'
          ? 'SELECT record_id FROM run WHERE number=?'
          : 'SELECT record_id FROM run WHERE record_id=?',
      )
      .get(parsed.kind === 'number' ? parsed.number : parsed.recordId)?.record_id ?? null
  )
}
