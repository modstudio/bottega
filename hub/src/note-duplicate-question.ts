// concern: note-duplicate-question
/** Selects note pairs, asks the duplicate question, and records observed outcomes. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { newRecordId } from '../../shared/record-id.ts'
import type { NoulQuestion } from '../../shared/typed-question/registry.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { duplicateScore } from './task.ts'
import { askHubTypedQuestion } from './typed-question-service.ts'

export const NOTE_DUPLICATE_QUESTION: NoulQuestion = {
  id: 'note_duplicate',
  version: 1,
  type: 'noul',
  threshold: 0.8,
  instructions:
    'These are two one-line engineering observations filed in the same project. Judge whether they report the same underlying problem, so that the second is another sighting of the first.',
}

export const NOTE_DUPLICATE_CANDIDATES = 20
const NOTE_DUPLICATE_CONCURRENCY = 8

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

function noteTextHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

function notePairSubjectRef(existingRecordId: string, text: string): string {
  return `${existingRecordId}:${noteTextHash(text)}`
}

type AskedNote<T> = { note: T; probability: number }

export function jevOnlyDuplicateCandidates<T extends { record_id: string }>(
  lexical: readonly T[],
  asked: readonly AskedNote<T>[],
): Array<T & { probability: number }> {
  const lexicalIds = new Set(lexical.map((candidate) => candidate.record_id))
  return asked
    .filter(
      ({ note, probability }) =>
        probability >= NOTE_DUPLICATE_QUESTION.threshold && !lexicalIds.has(note.record_id),
    )
    .map(({ note, probability }) => ({ ...note, probability }))
}

export async function askNoteDuplicateQuestions<T extends DuplicateQuestionNote>(
  notes: readonly T[],
  project: string,
  text: string,
  ask = askHubTypedQuestion,
): Promise<AskedNote<RankedDuplicateQuestionNote<T>>[] | null> {
  const candidates = noteDuplicateQuestionCandidates(notes, project, text)
  const results: Array<AskedNote<RankedDuplicateQuestionNote<T>> | null> = new Array(
    candidates.length,
  )
  let cursor = 0
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor++
      const note = candidates[index]!
      const answer = await ask({
        question: NOTE_DUPLICATE_QUESTION,
        subjectKind: 'note-pair',
        subjectRef: notePairSubjectRef(note.record_id, text),
        state: { existing: note.text, new: text },
      })
      const probability = answer && 'noul' in answer ? answer.noul : null
      results[index] = probability === null ? null : { note, probability }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(NOTE_DUPLICATE_CONCURRENCY, candidates.length) }, worker),
  )
  return results.some((result) => result === null)
    ? null
    : (results as AskedNote<RankedDuplicateQuestionNote<T>>[])
}

function recordedSubjectRefs(text: string, database: Database): string[] {
  const suffix = `:${noteTextHash(text)}`
  return database
    .query<{ subject_ref: string }, [string, number, string]>(
      `SELECT DISTINCT subject_ref FROM typed_question_answer
       WHERE question_id=? AND question_version=? AND subject_ref LIKE '%' || ?
       `,
    )
    .all(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version, suffix)
    .map((row) => row.subject_ref)
}

export function recordNoteDuplicateOutcomes(
  text: string,
  source: 'same-as' | 'new',
  existingRecordId?: string,
): void {
  const database = db()
  const refs = recordedSubjectRefs(text, database).filter(
    (subjectRef) => source === 'new' || subjectRef === notePairSubjectRef(existingRecordId!, text),
  )
  if (!refs.length) return
  const at = nowIso()
  writeTransaction((conn) => {
    for (const subjectRef of refs) {
      conn
        .query(
          `INSERT INTO typed_question_outcome
           (record_id,question_id,question_version,subject_ref,label,source,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          newRecordId(),
          NOTE_DUPLICATE_QUESTION.id,
          NOTE_DUPLICATE_QUESTION.version,
          subjectRef,
          source === 'same-as' ? 1 : 0,
          source,
          at,
        )
    }
  })
}

export function recordNoteDuplicateMerge(targetRecordId: string, sourceText: string): void {
  const subjectRef = notePairSubjectRef(targetRecordId, sourceText)
  const exists = db()
    .query(
      `SELECT 1 FROM typed_question_answer WHERE question_id=? AND question_version=?
       AND subject_ref=?`,
    )
    .get(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version, subjectRef)
  if (!exists) return
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO typed_question_outcome
         (record_id,question_id,question_version,subject_ref,label,source,created_at)
         VALUES (?,?,?,?,1,'merge',?)`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        subjectRef,
        nowIso(),
      )
  })
}

export function noteDuplicateLabel(database: Database, subjectRef: string): boolean | null {
  const row = database
    .query<{ label: number }, [string, number, string]>(
      `SELECT label FROM typed_question_outcome
       WHERE question_id=? AND question_version=? AND subject_ref=?
       ORDER BY (source='merge') DESC, created_at DESC, record_id DESC LIMIT 1`,
    )
    .get(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version, subjectRef)
  return row ? Boolean(row.label) : null
}

