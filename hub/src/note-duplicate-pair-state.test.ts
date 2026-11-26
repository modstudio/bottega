import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations } from './migrations.ts'
import { readNoteDuplicateSubjects } from './note-duplicate-pair-state.ts'
import { NOTE_DUPLICATE_QUESTION, notePairSubjectRef } from './note-duplicate-question.ts'

test('a missing existing note makes an unstored pair state unreadable', () => {
  const database = new Database(':memory:')
  applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  const subjectRef = notePairSubjectRef(newRecordId(), 'deleted newer note')
  database
    .query(
      `INSERT INTO typed_question_outcome
       (record_id,question_id,question_version,subject_ref,label,source,created_at)
       VALUES (?,?,?,?,1,'merge','2026-01-01T00:00:00Z')`,
    )
    .run(newRecordId(), NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version, subjectRef)

  const subjects = readNoteDuplicateSubjects(database, new Map())

  expect(subjects.readable).toEqual([])
  expect(subjects.unreadable).toMatchObject([{ subjectRef, label: true, source: 'merge' }])
  database.close()
})
