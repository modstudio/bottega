// concern: record-reference
/** Parses human record references without consulting a store, process, or clock. */

import { hasRecordIdShape } from './record-id.ts'
import { malformedReferenceRefusal } from './reference-refusal.ts'

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
  | { kind: 'run'; reference: ParsedReference; source: string; explicit: boolean }
  | { kind: 'pull-request'; number: number | null; url: string | null }
  | { kind: 'commit'; sha: string }
  | { kind: 'probe' | 'exec' | 'review-read' | 'attached-text'; recordId: string }

const taskKeyPattern = '[A-Z][A-Z0-9]*-[1-9][0-9]*'
const githubPullRequestPattern = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/([1-9][0-9]*)$/i

function parseNamedPointerReference(value: string): PointerReference | null {
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
    const path = /^[a-z][a-z0-9-]*\/(?:_|[A-Za-z0-9][A-Za-z0-9._-]*)\/(\S+)$/.exec(address)
    if (hasRecordIdShape(address) || (path && !path[1]!.split('/').includes('..')))
      return { kind: 'doc', address }
    return null
  }
  const stored = /^(probe|exec|review-read|attached-text):(.+)$/i.exec(value)
  if (!stored || !hasRecordIdShape(stored[2]!)) return null
  return {
    kind: stored[1]!.toLowerCase() as 'probe' | 'exec' | 'review-read' | 'attached-text',
    recordId: stored[2]!.toLowerCase(),
  }
}

/** Parses the syntax shared by durable context pointers and workflow evidence. */
export function parsePointerReference(input: string): PointerReference {
  const value = input.trim()
  if (!value || value !== input) throw new Error(malformedReferenceRefusal(input))

  const named = parseNamedPointerReference(value)
  if (named) return named

  const pullRequest = /^#([1-9][0-9]*)$/.exec(value)
  if (pullRequest) return { kind: 'pull-request', number: Number(pullRequest[1]), url: null }
  const pullRequestUrl = githubPullRequestPattern.exec(value)
  if (pullRequestUrl) return { kind: 'pull-request', number: Number(pullRequestUrl[1]), url: value }

  if (/^[0-9]{40}$/.test(value) || (/^[0-9a-f]{7,40}$/i.test(value) && /[a-f]/i.test(value)))
    return { kind: 'commit', sha: value }
  const explicitRun = /^run:(\S+)$/i.exec(value)
  const source = explicitRun?.[1] ?? value
  try {
    const reference = parseReference(source, 'run')
    const runValue = reference.value
    if (
      runValue.kind === 'record-id' ||
      runValue.kind === 'number' ||
      (runValue.kind === 'label' && runValue.prefix === REFERENCE_PREFIXES.run)
    )
      return { kind: 'run', reference, source, explicit: Boolean(explicitRun) }
  } catch {
    // The shared pointer refusal below owns malformed pointer wording.
  }

  throw new Error(malformedReferenceRefusal(input))
}
