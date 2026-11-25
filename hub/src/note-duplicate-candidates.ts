// concern: note-duplicate-candidates
/** Selects the bounded lexical set considered by note duplicate questions. */

import { duplicateScore } from './duplicate-score.ts'

export const NOTE_DUPLICATE_CANDIDATES = 20

export type DuplicateQuestionNote = {
  record_id: string
  project: string
  text: string
  stale_at: string | null
}

export type RankedDuplicateQuestionNote<T extends DuplicateQuestionNote = DuplicateQuestionNote> =
  T & { score: number }

export function noteDuplicateQuestionCandidates<T extends DuplicateQuestionNote>(
  notes: readonly T[],
  project: string,
  text: string,
): RankedDuplicateQuestionNote<T>[] {
  return notes
    .filter((note) => note.project === project && note.stale_at === null)
    .map((note) => ({ ...note, score: duplicateScore(note.text, text) }))
    .sort(
      (left, right) => right.score - left.score || left.record_id.localeCompare(right.record_id),
    )
    .slice(0, NOTE_DUPLICATE_CANDIDATES)
}
