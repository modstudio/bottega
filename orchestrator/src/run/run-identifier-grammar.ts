// concern: run-control
/** Recognizes a user-facing run number or UUID. Pure: it knows no store, process, or clock. */

import { hasRecordIdShape } from '../../../shared/record-id.ts'

export type ParsedRunIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export const ACCEPTED_RUN_IDENTIFIERS = 'a positive decimal run number or a full run UUID'

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
