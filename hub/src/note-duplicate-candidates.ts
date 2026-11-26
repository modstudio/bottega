// concern: note-duplicate-candidates
/** Selects the bounded lexical set considered by note duplicate questions. */

import { duplicateTokenSet, duplicateTokenSetScore } from './duplicate-score.ts'

export const NOTE_DUPLICATE_CANDIDATES = 20

export type DuplicateQuestionNote = {
  record_id: string
  project: string
  text: string
  stale_at: string | null
}

export type RankedDuplicateQuestionNote<T extends DuplicateQuestionNote = DuplicateQuestionNote> =
  T & { score: number }

export type DuplicateTokenEntry = {
  record_id: string
  tokens: ReadonlySet<string>
}

export function rankDuplicateCandidates<T extends DuplicateTokenEntry>(
  entries: readonly T[],
  targetTokens: ReadonlySet<string>,
): Array<T & { score: number }> {
  return entries
    .map((entry) => ({ ...entry, score: duplicateTokenSetScore(entry.tokens, targetTokens) }))
    .sort(
      (left, right) => right.score - left.score || left.record_id.localeCompare(right.record_id),
    )
    .slice(0, NOTE_DUPLICATE_CANDIDATES)
}

export function noteDuplicateQuestionCandidates<T extends DuplicateQuestionNote>(
  notes: readonly T[],
  project: string,
  text: string,
): RankedDuplicateQuestionNote<T>[] {
  return rankDuplicateCandidates(
    notes
      .filter((note) => note.project === project && note.stale_at === null)
      .map((note) => ({ ...note, tokens: duplicateTokenSet(note.text) })),
    duplicateTokenSet(text),
  ).map(({ tokens: _tokens, ...note }) => note)
}
