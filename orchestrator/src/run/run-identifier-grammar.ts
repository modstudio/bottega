// concern: run-control
/** Recognizes a user-facing run number or UUID. Pure: it knows no store, process, or clock. */

import { parseReference, REFERENCE_PREFIXES } from '../../../shared/reference.ts'
import {
  decideMachineLabel,
  type MachineIdentifierNames,
  stripMachineLabel,
} from '../record/machine-name.ts'

export type ParsedRunIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

const ACCEPTED_RUN_IDENTIFIERS =
  'an r-prefixed run number, positive decimal run number, name/number, or a full run UUID'

function classifyBareRunIdentifier(input: string | number): ParsedRunIdentifier | null {
  const given = String(input)
  try {
    const reference = parseReference(given, 'run')
    if (reference.qualifier !== null) return null
    if (reference.value.kind === 'label' && reference.value.prefix === REFERENCE_PREFIXES.run)
      return { kind: 'number', number: reference.value.number }
    if (reference.value.kind === 'number') return { kind: 'number', number: reference.value.number }
    if (reference.value.kind === 'record-id')
      return { kind: 'record-id', recordId: reference.value.recordId }
  } catch {
    return null
  }
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
