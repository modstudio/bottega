// concern: run-control
/** Resolves a user-facing run number or UUID to the run UUID. */

import type { Database } from 'bun:sqlite'
import {
  ACCEPTED_RUN_IDENTIFIERS,
  classifyRunIdentifier,
  parseRunIdentifier,
} from './run-identifier-grammar.ts'

export { classifyRunIdentifier, parseRunIdentifier }

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
