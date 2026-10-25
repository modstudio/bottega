import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent, runEventsPath } from '../events.ts'
import { throttleBuckets } from './health.ts'
import { bucketThrottles } from './throttle-health.ts'

test('throttles are bucketed by live codex concurrency', () => {
  expect(bucketThrottles([{ concurrency: 8 }, { concurrency: 6 }, { concurrency: 8 }])).toEqual([
    { concurrency: 6, throttles: 1 },
    { concurrency: 8, throttles: 2 },
  ])
})

test('the report reads only codex runs started inside its window', () => {
  const runId = addRun({
    agent: 'codex',
    job: 'craft',
    startedAt: '2026-10-21T00:00:00.000Z',
  })
  const path = runEventsPath(runId)
  appendRunEvent(
    runId,
    {
      ts: '2026-10-20T00:00:00.000Z',
      type: 'throttled',
      attempt: 1,
      max: 5,
      retryDelayMs: 225_000,
      retryAt: '2026-10-20T00:03:45.000Z',
      status: 429,
      concurrency: 6,
    },
    path,
  )
  appendRunEvent(
    runId,
    {
      ts: '2026-10-21T00:00:00.000Z',
      type: 'throttled',
      attempt: 1,
      max: 5,
      retryDelayMs: 225_000,
      retryAt: '2026-10-21T00:03:45.000Z',
      status: 429,
      concurrency: 8,
    },
    path,
  )

  const oldRunId = addRun({
    agent: 'codex',
    job: 'craft',
    startedAt: '2026-10-01T00:00:00.000Z',
  })
  appendRunEvent(
    oldRunId,
    {
      ts: '2026-10-22T00:00:00.000Z',
      type: 'throttled',
      attempt: 1,
      max: 5,
      retryDelayMs: 225_000,
      retryAt: '2026-10-22T00:03:45.000Z',
      status: 429,
      concurrency: 10,
    },
    runEventsPath(oldRunId),
  )

  expect(throttleBuckets({ database: db(), from: '2026-10-21T00:00:00.000Z' })).toEqual([
    { concurrency: 8, throttles: 1 },
  ])
})
