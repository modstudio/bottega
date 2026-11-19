import { parseReference, REFERENCE_PREFIXES } from './reference.ts'

export type NoteLabel = { project: string; number: number }

export function formatNoteLabel(project: string, number: number): string {
  return `${project}#${number}`
}

export function parseNoteLabel(value: string): NoteLabel {
  try {
    const parsed = parseReference(value, 'note')
    const number = 'number' in parsed.value ? parsed.value.number : null
    const qualifier = parsed.qualifier
    if (
      qualifier?.kind === 'project' &&
      (parsed.value.kind === 'number' ||
        (parsed.value.kind === 'label' && parsed.value.prefix === REFERENCE_PREFIXES.note)) &&
      number !== null
    )
      return { project: qualifier.value, number }
  } catch {
    // The note-label surface keeps its established refusal below.
  }
  throw new Error(`invalid note label '${value}': expected project#number`)
}
