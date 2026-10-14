import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendQuestionDeliveries } from './question-delivery.ts'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('question delivery rows mint a version-7 record id', () => {
  const runId = addRun({ agent: 'codex', job: 'implement' })
  const questionId = (
    db()
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question)
         VALUES (? ,?, '2026-10-14', 'Which?') RETURNING id`,
      )
      .get(newRecordId(), runId) as { id: number }
  ).id
  appendQuestionDeliveries([questionId], {
    runId,
    mode: 'resume',
    outcome: 'delivered',
    at: '2026-10-14T00:00:00.000Z',
  })
  expect(
    db().query<{ record_id: string }, []>('SELECT record_id FROM question_delivery').get()
      ?.record_id,
  ).toMatch(UUID_V7)
})
