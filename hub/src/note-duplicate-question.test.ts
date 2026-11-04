import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { db, writeTransaction } from './db.ts'
import {
  jevOnlyDuplicateCandidates,
  NOTE_DUPLICATE_CANDIDATES,
  NOTE_DUPLICATE_QUESTION,
  noteDuplicateLabel,
  noteDuplicateQuestionCandidates,
} from './note-duplicate-question.ts'

const note = (recordId: string, project: string, text: string, staleAt: string | null = null) => ({
  record_id: recordId,
  project,
  text,
  stale_at: staleAt,
})

test('ranks all non-stale project notes by duplicate score and keeps the named limit', () => {
  const notes = [
    note('other', 'other', 'alpha beta'),
    note('stale', 'project', 'alpha beta', '2026-01-01'),
    ...Array.from({ length: NOTE_DUPLICATE_CANDIDATES + 2 }, (_, index) =>
      note(String(index).padStart(2, '0'), 'project', index === 0 ? 'alpha beta' : `note ${index}`),
    ),
  ]
  const selected = noteDuplicateQuestionCandidates(notes, 'project', 'alpha beta')
  expect(selected).toHaveLength(NOTE_DUPLICATE_CANDIDATES)
  expect(selected[0]).toMatchObject({ record_id: '00', score: 1 })
  expect(selected.map((candidate) => candidate.record_id)).not.toContain('other')
  expect(selected.map((candidate) => candidate.record_id)).not.toContain('stale')
})

test('adds only Jev-only candidates at or above the threshold', () => {
  const lexical = [{ record_id: 'lexical', text: 'lexical' }]
  const asked = [
    { note: lexical[0]!, probability: 1 },
    {
      note: { record_id: 'boundary', text: 'boundary' },
      probability: NOTE_DUPLICATE_QUESTION.threshold,
    },
    {
      note: { record_id: 'below', text: 'below' },
      probability: NOTE_DUPLICATE_QUESTION.threshold - 0.01,
    },
  ]
  expect(jevOnlyDuplicateCandidates(lexical, asked)).toEqual([
    { record_id: 'boundary', text: 'boundary', probability: NOTE_DUPLICATE_QUESTION.threshold },
  ])
})

function outcome(subjectRef: string, label: boolean, source: string, createdAt: string): void {
  writeTransaction((database) => {
    database
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
        Number(label),
        source,
        createdAt,
      )
  })
}

test('labels from the latest merge even when a later new outcome exists', () => {
  const subject = newRecordId()
  outcome(subject, true, 'merge', '2026-01-01T00:00:00Z')
  outcome(subject, false, 'new', '2026-01-02T00:00:00Z')
  expect(noteDuplicateLabel(db(), subject)).toBeTrue()
})

test('labels from the latest outcome when no merge exists and returns null without one', () => {
  const subject = newRecordId()
  outcome(subject, true, 'same-as', '2026-01-01T00:00:00Z')
  outcome(subject, false, 'new', '2026-01-02T00:00:00Z')
  expect(noteDuplicateLabel(db(), subject)).toBeFalse()
  expect(noteDuplicateLabel(db(), newRecordId())).toBeNull()
})
