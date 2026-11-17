// concern: run-control
/** Resolves a user-facing run number or UUID to the run UUID. */

import type { Database } from 'bun:sqlite'
import { ResolutionMissError, resolveLocalRun } from '../identity/identity-local-run.ts'
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
  try {
    return resolveLocalRun(database, parsed).record_id
  } catch (error) {
    if (error instanceof ResolutionMissError) return null
    throw error
  }
}
