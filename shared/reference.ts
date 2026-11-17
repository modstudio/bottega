// concern: record-reference
/** Parses human record references without consulting a store, process, or clock. */

import { hasRecordIdShape } from './record-id.ts'

export type ReferenceKind = 'question' | 'run' | 'task'
export const REFERENCE_PREFIXES = { question: 'q', run: 'r' } as const

export function formatReference(kind: keyof typeof REFERENCE_PREFIXES, number: number): string {
  return `${REFERENCE_PREFIXES[kind]}${number}`
}

export type ReferenceQualifier =
  | { kind: 'project'; value: string }
  | { kind: 'machine'; value: string }

export type ParsedReference = {
  qualifier: ReferenceQualifier | null
  value:
    | { kind: 'record-id'; recordId: string }
    | { kind: 'label'; prefix: string; number: number }
    | { kind: 'task-key'; key: string }
    | { kind: 'number'; number: number; referenceKind: Exclude<ReferenceKind, 'task'> }
}

const positiveNumber = (value: string): number | null => {
  if (!/^[0-9]+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function splitQualifier(original: string): {
  qualifier: ReferenceQualifier | null
  remainder: string
} {
  const projectSeparator = original.indexOf('#')
  const machineSeparator = original.indexOf('/')
  if (projectSeparator >= 0 && machineSeparator >= 0)
    throw new Error(`invalid reference ${JSON.stringify(original)}: pass one qualifier`)
  if (projectSeparator < 0 && machineSeparator < 0) return { qualifier: null, remainder: original }
  const separator = projectSeparator >= 0 ? projectSeparator : machineSeparator
  const value = original.slice(0, separator)
  const remainder = original.slice(separator + 1)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || !remainder)
    throw new Error(`invalid reference ${JSON.stringify(original)}: malformed qualifier`)
  return {
    qualifier: { kind: projectSeparator >= 0 ? 'project' : 'machine', value },
    remainder,
  }
}

function parseValue(
  original: string,
  remainder: string,
  referenceKind?: Exclude<ReferenceKind, 'task'>,
): ParsedReference['value'] {
  if (hasRecordIdShape(remainder)) return { kind: 'record-id', recordId: remainder.toLowerCase() }
  if (/^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/.test(remainder))
    return { kind: 'task-key', key: remainder }
  const label = remainder.match(/^([a-z]+)([1-9][0-9]*)$/)
  const labelNumber = label ? positiveNumber(label[2]!) : null
  if (label && labelNumber !== null)
    return { kind: 'label', prefix: label[1]!, number: labelNumber }
  const number = positiveNumber(remainder)
  if (number !== null && referenceKind) return { kind: 'number', number, referenceKind }
  if (number !== null)
    throw new Error(`invalid reference ${JSON.stringify(original)}: a bare number requires a kind`)
  throw new Error(
    `invalid reference ${JSON.stringify(original)}: expected a UUID, kind-prefixed label, task key, or qualified reference`,
  )
}

export function parseReference(
  input: string | number,
  referenceKind?: Exclude<ReferenceKind, 'task'>,
): ParsedReference {
  const original = String(input)
  if (!original || original.trim() !== original)
    throw new Error(
      `invalid reference ${JSON.stringify(original)}: references cannot be empty or padded`,
    )

  const { qualifier, remainder } = splitQualifier(original)
  return { qualifier, value: parseValue(original, remainder, referenceKind) }
}
