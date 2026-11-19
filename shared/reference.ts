// concern: record-reference
/** Parses human record references without consulting a store, process, or clock. */

import { hasRecordIdShape } from './record-id.ts'

export type ReferenceKind = 'note' | 'question' | 'run' | 'task'
export const REFERENCE_PREFIXES = { note: 'n', question: 'q', run: 'r' } as const

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

export type PointerReference =
  | { kind: 'doc'; address: string }
  | { kind: 'task'; key: string }
  | { kind: 'comment'; key: string; id: string }
  | { kind: 'task-document'; key: string; number: number }
  | { kind: 'run'; reference: string }
  | { kind: 'pull-request'; number: number | null; url: string | null }
  | { kind: 'commit'; sha: string }
  | { kind: 'probe' | 'exec' | 'review-read' | 'attached-text'; recordId: string }

export const POINTER_REFERENCE_FORMS =
  'doc:<scope>/<subject-or-_>/<slug>, doc:<UUID>, task:<KEY>, task:<KEY>#comment:<id>, <KEY>/<document number>, a run number, r<number>, run:<number-or-UUID>, a run UUID, #<pull request number>, a GitHub pull-request link, a commit SHA, probe:<UUID>, exec:<UUID>, review-read:<UUID>, or attached-text:<UUID>'

const taskKeyPattern = '[A-Z][A-Z0-9]*-[1-9][0-9]*'
const githubPullRequestPattern = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/([1-9][0-9]*)$/i

/** Parses the syntax shared by durable context pointers and workflow evidence. */
export function parsePointerReference(input: string): PointerReference {
  const value = input.trim()
  if (!value || value !== input)
    throw new Error(
      `reference ${JSON.stringify(input)} is malformed; pass ${POINTER_REFERENCE_FORMS}`,
    )

  const comment = new RegExp(`^task:(${taskKeyPattern})#comment:(\\S+)$`, 'i').exec(value)
  if (comment) return { kind: 'comment', key: comment[1]!.toUpperCase(), id: comment[2]! }
  const task = new RegExp(`^task:(${taskKeyPattern})$`, 'i').exec(value)
  if (task) return { kind: 'task', key: task[1]!.toUpperCase() }
  const taskDocument = new RegExp(`^(${taskKeyPattern})/([1-9][0-9]*)$`, 'i').exec(value)
  if (taskDocument)
    return {
      kind: 'task-document',
      key: taskDocument[1]!.toUpperCase(),
      number: Number(taskDocument[2]),
    }

  const doc = /^doc:(\S+)$/i.exec(value)
  if (doc) {
    const address = doc[1]!
    if (
      hasRecordIdShape(address) ||
      /^[a-z][a-z0-9-]*\/(?:_|[A-Za-z0-9][A-Za-z0-9._-]*)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
        address,
      )
    )
      return { kind: 'doc', address }
    throw new Error(
      `reference ${JSON.stringify(input)} is malformed; pass ${POINTER_REFERENCE_FORMS}`,
    )
  }

  const stored = /^(probe|exec|review-read|attached-text):(.+)$/i.exec(value)
  if (stored && hasRecordIdShape(stored[2]!))
    return {
      kind: stored[1]!.toLowerCase() as 'probe' | 'exec' | 'review-read' | 'attached-text',
      recordId: stored[2]!.toLowerCase(),
    }

  const pullRequest = /^#([1-9][0-9]*)$/.exec(value)
  if (pullRequest) return { kind: 'pull-request', number: Number(pullRequest[1]), url: null }
  const pullRequestUrl = githubPullRequestPattern.exec(value)
  if (pullRequestUrl) return { kind: 'pull-request', number: Number(pullRequestUrl[1]), url: value }

  if (/^[0-9]{40}$/.test(value) || (/^[0-9a-f]{7,40}$/i.test(value) && /[a-f]/i.test(value)))
    return { kind: 'commit', sha: value }
  const explicitRun = /^run:(\S+)$/i.exec(value)
  if (explicitRun && (/^[1-9][0-9]*$/.test(explicitRun[1]!) || hasRecordIdShape(explicitRun[1]!)))
    return { kind: 'run', reference: explicitRun[1]! }
  if (hasRecordIdShape(value)) return { kind: 'run', reference: value.toLowerCase() }
  if (/^(?:r[1-9][0-9]*|[1-9][0-9]*)$/.test(value)) return { kind: 'run', reference: value }

  throw new Error(
    `reference ${JSON.stringify(input)} is malformed; pass ${POINTER_REFERENCE_FORMS}`,
  )
}
