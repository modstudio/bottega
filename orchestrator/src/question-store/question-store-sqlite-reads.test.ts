import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { questionsForRun } from './question-store-sqlite-reads.ts'

test('questions for run reports whether the run asked a question', () => {
  const runId = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
  db()
    .query(
      `INSERT INTO question(record_id,number,run_record_id,asked_at,question)
       VALUES (?,1,?,'2026-11-18T00:00:00.000Z','Which?')`,
    )
    .run(newRecordId(), runId)

  expect(questionsForRun(db(), runId)).toHaveLength(1)
})
