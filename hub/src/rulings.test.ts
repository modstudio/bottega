import { beforeAll, describe, expect, test } from 'bun:test'
import { ingestRunFixtures, resetFixtureStore, runFixture } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { listOpenRulings, measureRulings, rulingsPayload, rulingsStaleAfter } from './rulings.ts'

beforeAll(resetFixtureStore)

describe('run ingest', () => {
  test('a child-turn question is stored on that turn ref and listed while unanswered', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9301,
        session_id: 'sess-b',
        turns: [
          {
            id: 9302,
            started_at: '2026-09-04T19:00:00.000Z',
            latency_ms: null,
            vendor_tokens: null,
            vendor_cost_usd: null,
            status: 'running',
            turn: 2,
          },
        ],
        questions: [
          { id: 20, run_id: 9301, asked_at: '2026-09-04T18:50:00.000Z', answered_at: null },
          { id: 21, run_id: 9302, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
        ],
      }),
    )

    const stored = db()
      .query(
        `SELECT question_id, run_ref, root_ref FROM question
        WHERE question_id IN (20, 21) ORDER BY question_id`,
      )
      .all() as { question_id: number; run_ref: string; root_ref: string }[]
    expect(stored).toEqual([
      { question_id: 20, run_ref: 'orch:9301:turn:9301', root_ref: 'orch:9301' },
      { question_id: 21, run_ref: 'orch:9301:turn:9302', root_ref: 'orch:9301' },
    ])

    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    expect(listOpenRulings(clock).filter((row) => row.session_id === 'sess-b')).toEqual([
      {
        question_id: 20,
        task_key: 'ALP-118',
        session_id: 'sess-b',
        asked_at: '2026-09-04T18:50:00.000Z',
        age: 4_200_000,
      },
      {
        question_id: 21,
        task_key: 'ALP-118',
        session_id: 'sess-b',
        asked_at: '2026-09-04T19:00:00.000Z',
        age: 3_600_000,
      },
    ])
  })

  test('re-ingest records that a question was answered and drops it from open rulings', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9401,
        session_id: 'sess-c',
        questions: [
          { id: 31, run_id: 9401, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
        ],
      }),
    )
    await ingestRunFixtures(
      runFixture({
        id: 9401,
        session_id: 'sess-c',
        questions: [
          {
            id: 31,
            run_id: 9401,
            asked_at: '2026-09-04T19:00:00.000Z',
            answered_at: '2026-09-04T19:20:00.000Z',
          },
        ],
      }),
    )

    const row = db().query(`SELECT answered_at FROM question WHERE question_id = 31`).get() as {
      answered_at: string
    }
    expect(row.answered_at).toBe('2026-09-04T19:20:00.000Z')
    expect(listOpenRulings().filter((item) => item.session_id === 'sess-c')).toEqual([])
  })

  test('closed run questions are stored as closed and excluded from open rulings', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9451,
        session_id: 'sess-closed',
        questions: [
          {
            id: 35,
            run_id: 9451,
            asked_at: '2026-09-04T19:00:00.000Z',
            answered_at: null,
            closed_at: '2026-09-04T19:20:00.000Z',
            close_reason: 'run closed',
          },
          {
            id: 36,
            run_id: 9451,
            asked_at: '2026-09-04T19:05:00.000Z',
            answered_at: null,
          },
        ],
      }),
    )

    expect(
      db().query(`SELECT closed_at, close_reason FROM question WHERE question_id = 35`).get(),
    ).toEqual({
      closed_at: '2026-09-04T19:20:00.000Z',
      close_reason: 'run closed',
    })
    expect(
      listOpenRulings()
        .filter((item) => item.session_id === 'sess-closed')
        .map((item) => item.question_id),
    ).toEqual([36])
  })

  test('rulings payload defaults stale_after to 1h', () => {
    expect(rulingsStaleAfter()).toBe('1h')
    expect(rulingsPayload(Date.parse('2026-09-04T20:00:00.000Z')).stale_after).toBe('1h')
  })

  test('an old chain with a fresh open question is ingested', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9501,
        started_at: '2026-09-04T15:00:00.000Z',
        session_id: 'sess-old',
        latency_ms: 1000,
        status: 'asking',
        questions: [
          { id: 41, run_id: 9501, asked_at: '2026-09-04T19:55:00.000Z', answered_at: null },
        ],
      }),
    )
    const stored = db()
      .query(`SELECT asked_at, answered_at, session_id FROM question WHERE question_id = 41`)
      .get() as { asked_at: string; answered_at: string | null; session_id: string }
    expect(stored).toEqual({
      asked_at: '2026-09-04T19:55:00.000Z',
      answered_at: null,
      session_id: 'sess-old',
    })
    expect(listOpenRulings().some((row) => row.session_id === 'sess-old')).toBe(true)
  })

  test('a probe that reaches asking still records its question', async () => {
    const result = await ingestRunFixtures(
      runFixture({
        id: 5,
        probe: 1,
        status: 'asking',
        session_id: 'sess-probe',
        launch_key: 'DEV-3000',
        questions: [{ id: 4, run_id: 5, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null }],
      }),
    )
    expect(result).toEqual({ rows: 0, skipped: 1 })
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:5'`).get()).toBeNull()
    expect(
      db()
        .query(
          `SELECT question_id, task_key, session_id, asked_at, answered_at
         FROM question WHERE session_id = 'sess-probe'`,
        )
        .get(),
    ).toEqual({
      question_id: 4,
      task_key: 'DEV-3000',
      session_id: 'sess-probe',
      asked_at: '2026-09-04T19:00:00.000Z',
      answered_at: null,
    })
    const clock = Date.parse('2026-09-04T20:00:00.000Z')
    expect(listOpenRulings(clock).filter((row) => row.session_id === 'sess-probe')).toEqual([
      {
        question_id: 4,
        task_key: 'DEV-3000',
        session_id: 'sess-probe',
        asked_at: '2026-09-04T19:00:00.000Z',
        age: 3_600_000,
      },
    ])
  })
})

describe('ruling-loop measures', () => {
  test('measures provenance, waits, delivery fallback, open age, and operator answers', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    const asked = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
    const answered = (minutesAgo: number, waitMinutes: number) =>
      new Date(now - minutesAgo * 60_000 + waitMinutes * 60_000).toISOString()
    const questions = [
      {
        question_id: 1,
        asked_at: asked(180),
        answered_at: answered(180, 2),
        asked_via: 'reply' as const,
        answerer_kind: 'operator' as const,
        overturned_at: asked(30),
      },
      {
        question_id: 2,
        asked_at: asked(160),
        answered_at: answered(160, 10),
        asked_via: 'live' as const,
        answerer_kind: 'agent' as const,
      },
      {
        question_id: 3,
        asked_at: asked(150),
        answered_at: answered(150, 120),
        asked_via: 'reply' as const,
        answerer_kind: 'eval' as const,
      },
      {
        question_id: 4,
        asked_at: asked(90),
        answered_at: null,
        asked_via: 'reply' as const,
        answerer_kind: null,
      },
      {
        question_id: 5,
        asked_at: asked(60),
        answered_at: answered(60, 30),
        asked_via: null,
        answerer_kind: null,
      },
      {
        question_id: 6,
        asked_at: '2026-09-01T00:00:00.000Z',
        answered_at: null,
        asked_via: 'live' as const,
        answerer_kind: null,
      },
    ]
    const deliveries = [
      { question_id: 1, mode: 'resume' as const, outcome: 'failed' as const },
      { question_id: 1, mode: 'retry' as const, outcome: 'delivered' as const },
      { question_id: 2, mode: 'live' as const, outcome: 'delivered' as const },
      { question_id: 3, mode: 'resume' as const, outcome: 'delivered' as const },
      { question_id: 3, mode: 'retry' as const, outcome: 'delivered' as const },
      { question_id: 4, mode: 'record-only' as const, outcome: 'delivered' as const },
      { question_id: 5, mode: 'retry' as const, outcome: 'failed' as const },
      { question_id: 6, mode: 'live' as const, outcome: 'failed' as const },
    ]

    expect(measureRulings(questions, deliveries, { now, staleAfterMs: 60 * 60_000 })).toEqual({
      window: {
        days: 14,
        starts_at: '2026-09-10T12:00:00.000Z',
        ends_at: '2026-09-24T12:00:00.000Z',
      },
      questions_asked: {
        total: 5,
        by_asked_via: { live: 1, reply: 3, workflow: 0, unknown: 1 },
      },
      answer_wait: {
        overall: {
          count: 4,
          median_ms: 1_200_000,
          p90_ms: 7_200_000,
          under_5_minutes: 1,
          under_1_hour: 3,
          over_1_hour: 1,
        },
        by_answerer_kind: {
          agent: {
            count: 1,
            median_ms: 600_000,
            p90_ms: 600_000,
            under_5_minutes: 0,
            under_1_hour: 1,
            over_1_hour: 0,
          },
          operator: {
            count: 1,
            median_ms: 120_000,
            p90_ms: 120_000,
            under_5_minutes: 1,
            under_1_hour: 1,
            over_1_hour: 0,
          },
          eval: {
            count: 1,
            median_ms: 7_200_000,
            p90_ms: 7_200_000,
            under_5_minutes: 0,
            under_1_hour: 0,
            over_1_hour: 1,
          },
          unknown: {
            count: 1,
            median_ms: 1_800_000,
            p90_ms: 1_800_000,
            under_5_minutes: 0,
            under_1_hour: 1,
            over_1_hour: 0,
          },
        },
      },
      delivery: {
        by_mode_and_outcome: {
          live: { delivered: 1, failed: 0, retired: 0 },
          resume: { delivered: 1, failed: 1, retired: 0 },
          retry: { delivered: 2, failed: 1, retired: 0 },
          'record-only': { delivered: 1, failed: 0, retired: 0 },
        },
        stopped_turn: {
          delivered: 2,
          resume: 1,
          retry: 1,
          undelivered: 1,
          resume_share: 1 / 3,
          retry_share: 1 / 3,
        },
      },
      open: { count: 1, older_than_stale: 1 },
      operator_answers: { count: 1, median_wait_ms: 120_000 },
      overturns: {
        count: 1,
        rate: 0.5,
        by_answerer_kind: {
          operator: { count: 1, rate: 1 },
          agent: { count: 0, rate: 0 },
        },
      },
    })
  })
})
