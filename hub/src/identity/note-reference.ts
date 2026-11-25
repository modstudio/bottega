// concern: hub note-reference identity
/** Classifies a slim-list note reference without consulting a store. */

import { parseNoteLabel } from '../../../shared/note-label.ts'

export type SlimNoteReference = { project: string; number: number } | { recordId: string }

export function parseSlimNoteReference(reference: string): SlimNoteReference {
  try {
    return parseNoteLabel(reference)
  } catch {
    return { recordId: reference.toLowerCase() }
  }
}
