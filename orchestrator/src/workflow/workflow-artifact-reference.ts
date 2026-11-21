// concern: workflow-artifact-reference
/** Parses the artifact references accepted by workflow floor evidence. */

import {
  type PointerReference,
  parsePointerReference,
  parseReference,
} from '../../../shared/reference.ts'
import { MachineLabelRefusal } from '../record/machine-name.ts'
import { machineLabelRefusal } from '../run/run-identifier-names.ts'
import { parseProbeArtifact } from './probe-identifier.ts'

export type ArtifactRef =
  | { kind: 'task'; key: string }
  | { kind: 'comment'; key: string; id: string }
  | { kind: 'probe'; recordId: string }
  | { kind: 'exec'; recordId: string }
  | { kind: 'doc'; address: string }
  | { kind: 'run'; id: string }
  | { kind: 'review-read'; recordId: string }
  | { kind: 'attached-text'; id: string }
  | { kind: 'note'; reference: string }
  | { kind: 'pull-request'; url: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'id'; id: number }

export function parseArtifactRef(value: string): ArtifactRef | { error: string } {
  const trimmed = value.trim()
  try {
    const note = /^note:(\S+)$/i.exec(trimmed)
    if (note) {
      parseReference(note[1]!, 'note')
      return { kind: 'note', reference: note[1]! }
    }
    return artifactRefFromPointer(parsePointerReference(trimmed), trimmed)
  } catch (error) {
    const machineRefusal = legacyMachineLabelRefusal(trimmed)
    if (machineRefusal) return { error: machineRefusal }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function artifactRefFromPointer(
  parsed: PointerReference,
  source: string,
): ArtifactRef | { error: string } {
  if (parsed.kind === 'task' || parsed.kind === 'comment' || parsed.kind === 'doc') return parsed
  if (parsed.kind === 'pull-request')
    return { kind: 'pull-request', url: parsed.url ?? `#${parsed.number}` }
  if (parsed.kind === 'commit') return parsed
  if (parsed.kind === 'run') return runArtifactRef(parsed, source)
  if (parsed.kind === 'task-document')
    return { error: `--artifact ${source} must use a doc: reference for a document` }
  return parsed.kind === 'attached-text'
    ? { kind: 'attached-text', id: parsed.recordId }
    : { kind: parsed.kind, recordId: parsed.recordId }
}

function runArtifactRef(
  parsed: Extract<PointerReference, { kind: 'run' }>,
  source: string,
): ArtifactRef | { error: string } {
  if (parsed.reference.qualifier?.kind === 'machine') {
    const refusal = legacyMachineLabelRefusal(source)
    if (refusal) return { error: refusal }
  }
  const value = parsed.reference.value
  const id = value.kind === 'record-id' ? value.recordId : parsed.source
  if (parsed.explicit || parsed.reference.qualifier) return { kind: 'run', id }
  return value.kind === 'number' ? { kind: 'id', id: value.number } : { kind: 'run', id }
}

function legacyMachineLabelRefusal(value: string): string | null {
  try {
    parseProbeArtifact(value)
  } catch (error) {
    if (error instanceof MachineLabelRefusal) return error.message
  }
  return machineLabelRefusal(value)
}
