// concern: note-duplicate-pair-state
/** Reads the text state retained for ruled note-duplicate pairs. */

import type { Database } from 'bun:sqlite'
import {
  NOTE_DUPLICATE_QUESTION,
  noteDuplicateGoverningOutcome,
  noteTextHash,
  parseNotePairSubjectRef,
} from './note-duplicate-question.ts'

type NoteDuplicatePairState = { existing: string; new: string }
export type NoteDuplicateNoteLookup = ReadonlyMap<string, { project: string; text: string }>
export type NoteDuplicateSubject = {
  subjectRef: string
  existingId: string
  hash: string
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

function reconstructNotePairState(
  notes: NoteDuplicateNoteLookup,
  subjectRef: string,
): NoteDuplicatePairState | null {
  const parsed = parseNotePairSubjectRef(subjectRef)
  if (!parsed) return null
  const { existingId, hash } = parsed
  const existing = notes.get(existingId)
  if (!existing) return null
  const newer = [...notes]
    .filter(([recordId, note]) => recordId !== existingId && note.project === existing.project)
    .map(([, note]) => note)
    .find((note) => noteTextHash(note.text) === hash)
  return newer ? { existing: existing.text, new: newer.text } : null
}

export function readNoteDuplicateSubjects(
  database: Database,
  notes: NoteDuplicateNoteLookup,
  options: { project?: string; sources?: readonly string[] } = {},
): {
  readable: NoteDuplicateSubject[]
  unreadable: Array<Omit<NoteDuplicateSubject, 'state'>>
} {
  const refs = database
    .query<{ subject_ref: string }, [string, number]>(
      `SELECT DISTINCT subject_ref FROM typed_question_outcome
       WHERE question_id=? AND question_version=?`,
    )
    .all(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version)
  const readable: NoteDuplicateSubject[] = []
  const unreadable: Array<Omit<NoteDuplicateSubject, 'state'>> = []
  for (const { subject_ref: subjectRef } of refs) {
    const outcome = noteDuplicateGoverningOutcome(database, subjectRef)
    if (!outcome) continue
    if (options.sources && !options.sources.includes(outcome.source)) continue
    const parsed = parseNotePairSubjectRef(subjectRef)
    if (!parsed) continue
    if (options.project && notes.get(parsed.existingId)?.project !== options.project) continue
    const stored = database
      .query<{ state_json: string | null }, [string, string]>(
        `SELECT state_json FROM typed_question_answer WHERE question_id=? AND subject_ref=?
         AND state_json IS NOT NULL ORDER BY created_at DESC,record_id DESC LIMIT 1`,
      )
      .get(NOTE_DUPLICATE_QUESTION.id, subjectRef)
    const state =
      parsedState(stored?.state_json ?? null) ?? reconstructNotePairState(notes, subjectRef)
    const identity = { subjectRef, ...parsed, label: outcome.label, source: outcome.source }
    if (!state) unreadable.push(identity)
    else readable.push({ ...identity, state })
  }
  return { readable, unreadable }
}
