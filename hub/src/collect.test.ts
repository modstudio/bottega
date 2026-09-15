import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import * as dbMod from './db.ts'
import { db } from './db.ts'
import { runsSince } from './collect.ts'
import { ingestRuns } from './ingest/runs.ts'
import { listOpenRulings } from './rulings.ts'
import { clearOrchCache } from './serve.ts'
import {
  collectRunsAt,
  ingestRunFixtures,
  resetFixtureStore,
  runFixture,
} from '../test/run-fixtures.ts'

beforeAll(resetFixtureStore)
afterEach(clearOrchCache)

describe('run ingest', () => {
  test('runsSince keeps the two-hour window when collection is current', () => {
    db()
      .query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify('2026-09-04T11:00:00.000Z'))
    expect(runsSince(Date.parse('2026-09-04T12:00:00.000Z'))).toBe('2026-09-04T10:00:00.000Z')
  })

  test('an answer recorded during a collector gap is ingested on the next collect', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9901,
        session_id: 'sess-gap',
        questions: [
          { id: 61, run_id: 9901, asked_at: '2026-09-04T06:00:00.000Z', answered_at: null },
        ],
      }),
    )
    db()
      .query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify('2026-09-04T07:00:00.000Z'))

    const clock = Date.parse('2026-09-04T12:00:00.000Z')
    expect(runsSince(clock)).toBe('2026-09-04T07:00:00.000Z')

    await ingestRunFixtures(
      runFixture({
        id: 9901,
        session_id: 'sess-gap',
        questions: [
          {
            id: 61,
            run_id: 9901,
            asked_at: '2026-09-04T06:00:00.000Z',
            answered_at: '2026-09-04T07:30:00.000Z',
          },
        ],
      }),
    )
    const row = db().query(`SELECT answered_at FROM question WHERE question_id = 61`).get() as {
      answered_at: string
    }
    expect(row.answered_at).toBe('2026-09-04T07:30:00.000Z')
  })

  test('an answer recorded between the snapshot and the stamp is ingested on the following collect', async () => {
    const snapshot = '2026-09-04T10:00:00.000Z'
    const completion = '2026-09-04T10:00:10.000Z'
    const answeredAt = '2026-09-04T10:00:05.000Z'
    let now = snapshot
    const clock = spyOn(dbMod, 'nowIso').mockImplementation(() => now)
    const unanswered = runFixture({
      id: 10001,
      session_id: 'sess-snap',
      questions: [{ id: 1001, run_id: 10001, asked_at: snapshot, answered_at: null }],
    })
    const spawn = spyOn(Bun, 'spawn').mockImplementation((() => {
      now = completion
      return {
        stdout: new Blob([JSON.stringify(unanswered)]),
        stderr: new Blob(['']),
        exited: Promise.resolve(0),
      }
    }) as unknown as typeof Bun.spawn)
    try {
      await ingestRuns('2026-09-01T00:00:00.000Z')
      expect(collectRunsAt()).toBe(JSON.stringify(snapshot))
      expect(runsSince(Date.parse('2026-09-04T12:00:10.000Z'))).toBe(snapshot)
    } finally {
      spawn.mockRestore()
    }

    try {
      await ingestRunFixtures(
        runFixture({
          id: 10001,
          session_id: 'sess-snap',
          questions: [{ id: 1001, run_id: 10001, asked_at: snapshot, answered_at: answeredAt }],
        }),
      )
      const row = db().query(`SELECT answered_at FROM question WHERE question_id = 1001`).get() as {
        answered_at: string
      }
      expect(row.answered_at).toBe(answeredAt)
      expect(listOpenRulings().filter((item) => item.session_id === 'sess-snap')).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })
})
