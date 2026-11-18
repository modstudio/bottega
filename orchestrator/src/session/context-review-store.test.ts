import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { contextReviewWindow, recordContextReview } from './context-review-store.ts'

test('recording a context review writes its row and outbox mutation atomically', () => {
  const database = migratedTestDatabase()
  recordContextReview(
    { sessionId: 'session-a', intervalMs: 1_000, items: 2, flagged: 1, itemIds: ['a', 'b'] },
    {
      database,
      now: () => '2026-11-16T12:00:00.000Z',
      machine: () => '01990000-0000-7000-8000-000000000099',
    },
  )
  expect(
    database
      .query('SELECT session_id,interval_ms,items,flagged,item_ids FROM context_review')
      .get(),
  ).toEqual({
    session_id: 'session-a',
    interval_ms: 1_000,
    items: 2,
    flagged: 1,
    item_ids: '["a","b"]',
  })
  const outbox = database
    .query<{ kind: string; payload: string }, []>('SELECT kind,payload FROM outbox')
    .get()!
  expect(outbox.kind).toBe('context_review')
  expect(JSON.parse(outbox.payload)).toMatchObject({ intervalMs: 1_000, itemIds: '["a","b"]' })
  expect(contextReviewWindow('2026-11-16T00:00:00.000Z', database)).toEqual([
    {
      sessionId: 'session-a',
      at: '2026-11-16T12:00:00.000Z',
      items: 2,
      flagged: 1,
    },
  ])
  expect(contextReviewWindow('2026-11-17T00:00:00.000Z', database)).toEqual([])
  database.close()
})
