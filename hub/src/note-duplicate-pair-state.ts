// concern: note-duplicate-pair-state
/** Reads the text state retained for ruled note-duplicate pairs. */

import type { Database } from 'bun:sqlite'
import {
  NOTE_DUPLICATE_QUESTION,
  noteDuplicateGoverningOutcome,
  noteTextHash,
  parseNotePairSubjectRef,
} from './note-duplicate-question.ts'

export type NoteDuplicatePairState = { existing: string; new: string }
export type NoteDuplicateSubject = {
  subjectRef: string
  state: NoteDuplicatePairState
  label: boolean
  source: string
}

function parsedState(value: string | null): NoteDuplicatePairState | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Partial<NoteDuplicatePairState>
    return typeof parsed.existing === 'string' && typeof parsed.new === 'string'
      ? { existing: parsed.existing, new: parsed.new }
      : null
  } catch {
    return null
  }
}

export function reconstructNotePairState(
  database: Database,
  subjectRef: string,
): NoteDuplicatePairState | null {
  const parsed = parseNotePairSubjectRef(subjectRef)
  if (!parsed) return null
  const { existingId, hash } = parsed
  const existing = database
    .query<{ project: string; text: string }, [string]>(
      'SELECT project,text FROM note WHERE record_id=?',
    )
    .get(existingId)
  if (!existing) return null
  const newer = database
    .query<{ text: string }, [string, string]>(
      'SELECT text FROM note WHERE project=? AND record_id<>? ORDER BY created_at,record_id',
    )
    .all(existing.project, existingId)
    .find((note) => noteTextHash(note.text) === hash)
  return newer ? { existing: existing.text, new: newer.text } : null
}

export function readNoteDuplicateSubjects(
  database: Database,
  options: { project?: string; sources?: readonly string[] } = {},
): { readable: NoteDuplicateSubject[]; unreadable: number } {
  const refs = database
    .query<{ subject_ref: string }, [string, number]>(
      `SELECT DISTINCT subject_ref FROM typed_question_outcome
       WHERE question_id=? AND question_version=?`,
    )
    .all(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version)
  const readable: NoteDuplicateSubject[] = []
  let unreadable = 0
  for (const { subject_ref: subjectRef } of refs) {
    const outcome = noteDuplicateGoverningOutcome(database, subjectRef)
    if (!outcome) continue
    if (options.sources && !options.sources.includes(outcome.source)) continue
    if (options.project) {
      const parsed = parseNotePairSubjectRef(subjectRef)
      if (
        !parsed ||
        !database
          .query<{ present: number }, [string, string]>(
            'SELECT 1 AS present FROM note WHERE record_id=? AND project=?',
          )
          .get(parsed.existingId, options.project)
      )
        continue
    }
    const stored = database
      .query<{ state_json: string | null }, [string, string]>(
        `SELECT state_json FROM typed_question_answer WHERE question_id=? AND subject_ref=?
         AND state_json IS NOT NULL ORDER BY created_at DESC,record_id DESC LIMIT 1`,
      )
      .get(NOTE_DUPLICATE_QUESTION.id, subjectRef)
    const state =
      parsedState(stored?.state_json ?? null) ?? reconstructNotePairState(database, subjectRef)
    if (!state) unreadable += 1
    else readable.push({ subjectRef, state, label: outcome.label, source: outcome.source })
  }
  return { readable, unreadable }
}
