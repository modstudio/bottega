// concern: workflows
/** Pure plan-task compose refusal based only on note-promotion provenance. */

export type PromotedNoteFact = { label: string; promotedTask: string | null }
export type NoteProvenanceRead =
  | { kind: 'available'; notes: readonly PromotedNoteFact[] }
  | { kind: 'unavailable'; reason: string }

export function decidePlanTaskNoteProvenance(input: {
  workflow: string
  project: string
  key?: string
  read: NoteProvenanceRead
}): { kind: 'allow' } | { kind: 'refuse'; message: string } {
  if (input.workflow !== 'plan-task' || !input.key) return { kind: 'allow' }
  const remedy = `bottega workflow compose fix-defect --mode single --project ${input.project} --arg key=${input.key}`
  if (input.read.kind === 'unavailable')
    return {
      kind: 'refuse',
      message: `cannot compose plan-task because note-promotion provenance could not be read: ${input.read.reason}; retry, then use \`${remedy}\` if the task was promoted from a note`,
    }
  const note = input.read.notes.find((candidate) => candidate.promotedTask === input.key)
  if (!note) return { kind: 'allow' }
  return {
    kind: 'refuse',
    message: `task ${input.key} was promoted from note ${note.label}; compose the defect workflow with \`${remedy}\``,
  }
}
