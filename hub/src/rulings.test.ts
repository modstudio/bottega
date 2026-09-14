import { beforeAll, describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import { listOpenRulings, rulingsPayload, rulingsStaleAfter } from './rulings.ts'
import { ingestRunFixtures, resetFixtureStore, runFixture } from '../test/run-fixtures.ts'

beforeAll(resetFixtureStore)

describe('run ingest', () => {
  test('a child-turn question is stored on that turn ref and listed while unanswered', async () => {
    await ingestRunFixtures(runFixture({
      id: 9301,
      session_id: 'sess-b',
      turns: [{
        id: 9302,
        started_at: '2026-09-04T19:00:00.000Z',
        latency_ms: null,
        vendor_tokens: null,
        vendor_cost_usd: null,
        status: 'running',
        turn: 2,
      }],
      questions: [
        { id: 20, run_id: 9301, asked_at: '2026-09-04T18:50:00.000Z', answered_at: null },
        { id: 21, run_id: 9302, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
      ],
    }))

    const stored = db().query(
      `SELECT question_id, run_ref, root_ref FROM question
        WHERE question_id IN (20, 21) ORDER BY question_id`,
    ).all() as { question_id: number; run_ref: string; root_ref: string }[]
    expect(stored).toEqual([
      { question_id: 20, run_ref: 'orch:9301:turn:9301', root_ref: 'orch:9301' },
      { question_id: 21, run_ref: 'orch:9301:turn:9302', root_ref: 'orch:9301' },
    ])

    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    expect(listOpenRulings(clock).filter((row) => row.session_id === 'sess-b')).toEqual([
      {
        question_id: 20, task_key: 'ALP-118', session_id: 'sess-b',
        asked_at: '2026-09-04T18:50:00.000Z', age: 4_200_000,
      },
      {
        question_id: 21, task_key: 'ALP-118', session_id: 'sess-b',
        asked_at: '2026-09-04T19:00:00.000Z', age: 3_600_000,
      },
    ])
  })

  test('re-ingest records that a question was answered and drops it from open rulings', async () => {
    await ingestRunFixtures(runFixture({
      id: 9401,
      session_id: 'sess-c',
      questions: [
        { id: 31, run_id: 9401, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
      ],
    }))
    await ingestRunFixtures(runFixture({
      id: 9401,
      session_id: 'sess-c',
      questions: [
        { id: 31, run_id: 9401, asked_at: '2026-09-04T19:00:00.000Z', answered_at: '2026-09-04T19:20:00.000Z' },
      ],
    }))

    const row = db().query(
      `SELECT answered_at FROM question WHERE question_id = 31`,
    ).get() as { answered_at: string }
    expect(row.answered_at).toBe('2026-09-04T19:20:00.000Z')
    expect(listOpenRulings().filter((item) => item.session_id === 'sess-c')).toEqual([])
  })

  test('rulings payload defaults stale_after to 1h', () => {
    expect(rulingsStaleAfter()).toBe('1h')
    expect(rulingsPayload(Date.parse('2026-09-04T20:00:00.000Z')).stale_after).toBe('1h')
  })

  test('an old chain with a fresh open question is ingested', async () => {
    await ingestRunFixtures(runFixture({
      id: 9501,
      started_at: '2026-09-04T15:00:00.000Z',
      session_id: 'sess-old',
      latency_ms: 1000,
      status: 'asking',
      questions: [
        { id: 41, run_id: 9501, asked_at: '2026-09-04T19:55:00.000Z', answered_at: null },
      ],
    }))
    const stored = db().query(
      `SELECT asked_at, answered_at, session_id FROM question WHERE question_id = 41`,
    ).get() as { asked_at: string; answered_at: string | null; session_id: string }
    expect(stored).toEqual({
      asked_at: '2026-09-04T19:55:00.000Z', answered_at: null, session_id: 'sess-old',
    })
    expect(listOpenRulings().some((row) => row.session_id === 'sess-old')).toBe(true)
  })

  test('a probe that reaches asking still records its question', async () => {
    const result = await ingestRunFixtures(runFixture({
      id: 5,
      probe: 1,
      status: 'asking',
      session_id: 'sess-probe',
      launch_key: 'DEV-3000',
      questions: [
        { id: 4, run_id: 5, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
      ],
    }))
    expect(result).toEqual({ rows: 0, skipped: 1 })
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:5'`).get()).toBeNull()
    expect(db().query(
      `SELECT question_id, task_key, session_id, asked_at, answered_at
         FROM question WHERE session_id = 'sess-probe'`,
    ).get()).toEqual({
      question_id: 4, task_key: 'DEV-3000', session_id: 'sess-probe',
      asked_at: '2026-09-04T19:00:00.000Z', answered_at: null,
    })
    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    expect(listOpenRulings(clock).filter((row) => row.session_id === 'sess-probe')).toEqual([
      {
        question_id: 4, task_key: 'DEV-3000', session_id: 'sess-probe',
        asked_at: '2026-09-04T19:00:00.000Z', age: 3_600_000,
      },
    ])
  })
})
