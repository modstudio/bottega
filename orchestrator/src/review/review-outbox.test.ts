import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { backfillReviewRecords, enqueueChangedReviewRounds } from './review-outbox.ts'

test('review backfill enqueues the graph once and is idempotent', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(`INSERT INTO run
    (number, record_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
    VALUES (1, '01990000-0000-7000-8000-000000000010', '2026-09-15T00:00:00Z',
      'codex', 'review-lens', 'sha', 1, 'head', 'ok')`)
    .run()
  database
    .query(
      "INSERT INTO review (number, record_id, recorded_at) VALUES (1, '01990000-0000-7000-8000-000000000011', '2026-09-15T01:00:00Z')",
    )
    .run()
  database
    .query(`INSERT INTO review_lens
    (record_id, review_record_id, run_record_id, lens, agent, standards_read, files_covered, commands_run, could_not_verify)
    VALUES ('01990000-0000-7000-8000-000000000012', '01990000-0000-7000-8000-000000000011', '01990000-0000-7000-8000-000000000010', 'craft', 'codex', '[]', '[]', '[]', '[]')`)
    .run()
  database
    .query(`INSERT INTO review_finding
    (record_id, review_record_id, review_lens_record_id, ordinal, severity, location, evidence, proposed_correction)
    VALUES ('01990000-0000-7000-8000-000000000013', '01990000-0000-7000-8000-000000000011', '01990000-0000-7000-8000-000000000012', 1, 'major', 'a.ts:1', 'evidence', 'correct it')`)
    .run()

  expect(backfillReviewRecords(database)).toEqual({
    enqueuedReviews: 1,
    enqueuedReads: 0,
  })
  const records = database
    .query<{ kind: string; record_id: string }, []>(
      'SELECT kind, row_id AS record_id FROM outbox ORDER BY id',
    )
    .all()
  expect(records.map((row) => row.kind)).toEqual(['review', 'review_lens', 'review_finding'])
  expect(records.map((row) => row.record_id)).toEqual(
    records.map((row) => row.record_id).toSorted(),
  )
  expect(backfillReviewRecords(database)).toEqual({
    enqueuedReviews: 0,
    enqueuedReads: 0,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(3)

  database.query('UPDATE review SET round=2').run()
  expect(enqueueChangedReviewRounds(database)).toBe(1)
  expect(
    database
      .query<{ round: number }, []>(
        "SELECT json_extract(payload,'$.round') AS round FROM outbox WHERE kind='review' ORDER BY id DESC LIMIT 1",
      )
      .get(),
  ).toEqual({ round: 2 })
  expect(enqueueChangedReviewRounds(database)).toBe(0)
  database.close()
})
