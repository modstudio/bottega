import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { backfillReviewRecords } from './review-outbox.ts'

test('review backfill mints parent rows before children, enqueues the graph, and is idempotent', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(`INSERT INTO run
    (id, record_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head, status)
    VALUES (1, '01990000-0000-7000-8000-000000000010', '2026-09-15T00:00:00Z',
      'codex', 'review-lens', 'sha', 1, 'head', 'ok')`)
    .run()
  database.query("INSERT INTO review (id, recorded_at) VALUES (1, '2026-09-15T01:00:00Z')").run()
  database
    .query(`INSERT INTO review_lens
    (id, review_id, run_id, lens, agent, standards_read, files_covered, commands_run, could_not_verify)
    VALUES (1, 1, 1, 'craft', 'codex', '[]', '[]', '[]', '[]')`)
    .run()
  database
    .query(`INSERT INTO review_finding
    (id, review_id, review_lens_id, ordinal, severity, location, evidence, proposed_correction)
    VALUES (1, 1, 1, 1, 'major', 'a.ts:1', 'evidence', 'correct it')`)
    .run()

  expect(backfillReviewRecords(database)).toEqual({
    mintedReviews: 1,
    mintedLenses: 1,
    mintedFindings: 1,
    enqueuedReviews: 1,
  })
  const records = database
    .query<{ kind: string; record_id: string }, []>(
      'SELECT kind, record_id FROM outbox ORDER BY id',
    )
    .all()
  expect(records.map((row) => row.kind)).toEqual(['review', 'review_lens', 'review_finding'])
  expect(records.map((row) => row.record_id)).toEqual(
    records.map((row) => row.record_id).toSorted(),
  )
  expect(backfillReviewRecords(database)).toEqual({
    mintedReviews: 0,
    mintedLenses: 0,
    mintedFindings: 0,
    enqueuedReviews: 0,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(3)
  database.close()
})
