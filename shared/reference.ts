// concern: record-reference
/** Parses human record references without consulting a store, process, or clock. */

import { hasRecordIdShape } from './record-id.ts'

export type ReferenceKind = 'question' | 'run' | 'task'
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

export function parseReference(
  input: string | number,
  referenceKind?: Exclude<ReferenceKind, 'task'>,
): ParsedReference {
  const original = String(input)
  if (!original || original.trim() !== original)
    throw new Error(
      `invalid reference ${JSON.stringify(original)}: references cannot be empty or padded`,
    )

  let remainder = original
  let qualifier: ReferenceQualifier | null = null
  const projectSeparator = original.indexOf('#')
  const machineSeparator = original.indexOf('/')
  if (projectSeparator >= 0 && machineSeparator >= 0)
    throw new Error(`invalid reference ${JSON.stringify(original)}: pass one qualifier`)
  if (projectSeparator >= 0 || machineSeparator >= 0) {
    const separator = projectSeparator >= 0 ? projectSeparator : machineSeparator
    const value = original.slice(0, separator)
    remainder = original.slice(separator + 1)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || !remainder)
      throw new Error(`invalid reference ${JSON.stringify(original)}: malformed qualifier`)
    qualifier = { kind: projectSeparator >= 0 ? 'project' : 'machine', value }
  }

  if (hasRecordIdShape(remainder))
    return { qualifier, value: { kind: 'record-id', recordId: remainder.toLowerCase() } }
  const task = remainder.match(/^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/)
  if (task) return { qualifier, value: { kind: 'task-key', key: remainder } }
  const label = remainder.match(/^([a-z]+)([1-9][0-9]*)$/)
  if (label) {
    const number = positiveNumber(label[2]!)
    if (number !== null) return { qualifier, value: { kind: 'label', prefix: label[1]!, number } }
  }
  const number = positiveNumber(remainder)
  if (number !== null) {
    if (!referenceKind)
      throw new Error(
        `invalid reference ${JSON.stringify(original)}: a bare number requires a kind`,
      )
    return { qualifier, value: { kind: 'number', number, referenceKind } }
  }
  throw new Error(
    `invalid reference ${JSON.stringify(original)}: expected a UUID, kind-prefixed label, task key, or qualified reference`,
  )
}
