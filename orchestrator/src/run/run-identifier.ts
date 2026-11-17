// concern: run-control
/** Resolves a user-facing run number or UUID to the run UUID. */

import type { Database } from 'bun:sqlite'
import { resolveLocalRun } from '../identity/identity.ts'
import { classifyRunIdentifier, parseRunIdentifier } from './run-identifier-names.ts'

export { classifyRunIdentifier, parseRunIdentifier }

export function resolveRunIdentifier(database: Database, input: string | number): string {
  const parsed = parseRunIdentifier(input)
  return resolveLocalRun(database, parsed).record_id
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
