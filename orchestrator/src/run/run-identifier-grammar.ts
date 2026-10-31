// concern: run-control
/** Recognizes a user-facing run number or UUID. Pure: it knows no store, process, or clock. */

import { hasRecordIdShape } from '../../../shared/record-id.ts'
import {
  decideMachineLabel,
  type MachineIdentifierNames,
  stripMachineLabel,
} from '../record/machine-name.ts'

export type ParsedRunIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export const ACCEPTED_RUN_IDENTIFIERS =
  'a positive decimal run number, name/number, or a full run UUID'

export function classifyBareRunIdentifier(input: string | number): ParsedRunIdentifier | null {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  return null
}

export function classifyRunIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null,
): ParsedRunIdentifier | null {
  const original = String(input)
  const label = decideMachineLabel(original, names)
  if (label.kind === 'refused') return null
  const given = label.kind === 'bare' ? label.remainder : original
  return classifyBareRunIdentifier(given)
}

export function parseRunIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null,
): ParsedRunIdentifier {
  const original = String(input)
  const given = stripMachineLabel(original, names)
  const parsed = classifyBareRunIdentifier(given)
  if (parsed) return parsed
  throw new Error(
    `invalid run identifier ${JSON.stringify(original)}: expected ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}
