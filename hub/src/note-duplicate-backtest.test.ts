import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { db } from './db.ts'
import { applyMigrations } from './migrations.ts'
import {
  noteDuplicateBacktest,
  noteDuplicateHoldout,
  noteDuplicateSweep,
  reconstructNotePairState,
} from './note-duplicate-backtest.ts'
import { NOTE_DUPLICATE_QUESTION, notePairSubjectRef } from './note-duplicate-question.ts'

const metricRow = (probability: number, label: boolean) => ({
  probability,
  label,
  error: null,
  latencyMs: 1,
  inputTokens: 0,
})

test('holdout assignment is deterministic', () => {
  expect(noteDuplicateHoldout('held:0123456789abcdef')).toBeTrue()
  expect(noteDuplicateHoldout('tuning:0123456789abcdef')).toBeFalse()
})

test('reconstruction counts a missing existing note as unreadable state', () => {
  expect(reconstructNotePairState(db(), `${newRecordId()}:0123456789abcdef`)).toBeNull()
})

test('threshold sweep computes precision and recall on a fixed set', () => {
  const row = noteDuplicateSweep([
    metricRow(0.9, true),
    metricRow(0.8, false),
    metricRow(0.4, true),
  ]).find((candidate) => candidate.threshold === 0.8)!
  expect(row.precision).toBe(0.5)
  expect(row.recall).toBe(0.5)
  expect(row.warnedRate).toBe(2 / 3)
})

test('backtest reuses an answer by subject when reconstructed state differs', async () => {
  const database = new Database(':memory:')
  applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  const existingId = newRecordId()
  const existingText = `existing ${newRecordId()}`
  const newText = `new ${newRecordId()}`
  const subjectRef = notePairSubjectRef(existingId, newText)
  const insertNote = database.query(
    `INSERT INTO note (record_id,number,project,text,anchors,created_at,last_seen_at)
     VALUES (?,?,'backtest-project',?,'[]',?,?)`,
  )
  insertNote.run(existingId, 1, existingText, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  insertNote.run(newRecordId(), 2, newText, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
  database
    .query(
      `INSERT INTO typed_question_outcome
       (record_id,question_id,question_version,subject_ref,label,source,created_at)
       VALUES (?,?,?,?,1,'merge','2026-01-03T00:00:00Z')`,
    )
    .run(newRecordId(), NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version, subjectRef)
  database
    .query(
      `INSERT INTO typed_question_answer
       (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,state_json,
        answer_json,model,input_tokens,latency_ms,error,created_at)
       VALUES (?,?,?,?,?,'state-from-before-reconstruction',NULL,'{"noul":0.9}','jev',1,1,NULL,
               '2026-01-03T00:00:00Z')`,
    )
    .run(
      newRecordId(),
      NOTE_DUPLICATE_QUESTION.id,
      NOTE_DUPLICATE_QUESTION.version,
      'note-pair',
      subjectRef,
    )
  const before = database
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM typed_question_answer')
    .get()!.count
  await noteDuplicateBacktest(1, database, async () => {
    throw new Error('stored subject must not be re-asked')
  })
  const after = database
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM typed_question_answer')
    .get()!.count
  expect(after).toBe(before)
  database.close()
})
