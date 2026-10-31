// concern: run-control
/** Recognizes a user-facing run number or UUID. Pure: it knows no store, process, or clock. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { shortNameRefusal } from '../record/machine-name.ts'

export type MachineIdentifierNames = { shortName: string; formerShortNames: readonly string[] }
export type LabelDecision =
  | { kind: 'bare'; remainder: string }
  | { kind: 'not-label' }
  | { kind: 'refused'; reason: string }

export function decideMachineLabel(
  input: string,
  names: MachineIdentifierNames | null,
): LabelDecision {
  const match = /^([^/]+)\/(.+)$/.exec(input)
  if (!match || shortNameRefusal(match[1]!)) return { kind: 'not-label' }
  const name = match[1]!
  if (!names)
    return {
      kind: 'refused',
      reason: `this machine has no short name because it has not joined a space; a bare number or UUID works meanwhile; set the name by joining a space with \`${PLATFORM_SLUG} record space switch --short-name <name>\``,
    }
  if (name === names.shortName || names.formerShortNames.includes(name))
    return { kind: 'bare', remainder: match[2]! }
  return {
    kind: 'refused',
    reason: `\`${input}\` names a row on machine \`${name}\`; this command acts only on this machine's (\`${names.shortName}\`) rows`,
  }
}

export type ParsedRunIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export const ACCEPTED_RUN_IDENTIFIERS =
  'a positive decimal run number, name/number, or a full run UUID'

export function classifyRunIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null,
): ParsedRunIdentifier | null {
  const original = String(input)
  const label = decideMachineLabel(original, names)
  if (label.kind === 'refused') throw new Error(label.reason)
  const given = label.kind === 'bare' ? label.remainder : original
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  return null
}

export function parseRunIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null,
): ParsedRunIdentifier {
  const given = String(input)
  const parsed = classifyRunIdentifier(input, names)
  if (parsed) return parsed
  throw new Error(
    `invalid run identifier ${JSON.stringify(given)}: expected ${ACCEPTED_RUN_IDENTIFIERS}`,
  )
}
