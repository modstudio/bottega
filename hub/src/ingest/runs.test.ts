import { beforeAll, describe, expect, test } from 'bun:test'
import { engagedMs, human } from '../../../shared/interval.ts'
import {
  at,
  collectRunsAt,
  ingestRunFixtures,
  ingestStdout,
  resetFixtureStore,
  runFixture,
} from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { chainVendorTokens, executionSpans } from './runs.ts'

beforeAll(resetFixtureStore)

describe('run ingest', () => {
  test('routing replaces a pending reservation with the real interval', async () => {
    await ingestRunFixtures(runFixture({ id: 9101, agent: '(pending)' }))
    await ingestRunFixtures(
      runFixture({
        id: 9101,
        started_at: '2026-09-03T00:00:00.200Z',
        agent: 'grok',
        latency_ms: 5000,
        status: 'delivered',
      }),
    )

    const intervals = db()
      .query(
        `SELECT agent, start_at, open FROM interval WHERE source = 'orch' AND ref = 'orch:9101'`,
      )
      .all() as { agent: string; start_at: string; open: number }[]
    expect(intervals).toEqual([
      {
        agent: 'grok',
        start_at: '2026-09-03T00:00:00.200Z',
        open: 0,
      },
    ])
  })

  test('a stale run closes the interval recorded while it was running', async () => {
    await ingestRunFixtures(runFixture({ id: 9102 }))
    const result = await ingestRunFixtures(runFixture({ id: 9102, status: 'stale' }))

    const intervals = db()
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = 'orch:9102'`)
      .all() as { open: number }[]
    expect(intervals).toEqual([{ open: 0 }])
    expect(result).toEqual({ rows: 0, skipped: 1 })
  })

  test('an in-flight run stays open', async () => {
    const result = await ingestRunFixtures(runFixture({ id: 9103 }))

    const interval = db()
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = 'orch:9103'`)
      .get() as { open: number }
    expect(interval.open).toBe(1)
    expect(result).toEqual({ rows: 1, skipped: 0 })
  })

  test('a failover successor closes the execution interval it replaced', async () => {
    await ingestRunFixtures(runFixture({ id: 9104 }))
    await ingestRunFixtures(
      runFixture({
        id: 9105,
        retry_of: 9104,
        started_at: '2026-09-03T00:01:00.000Z',
      }),
    )

    const intervals = db()
      .query(
        `SELECT ref, open FROM interval
        WHERE source = 'orch' AND ref IN ('orch:9104', 'orch:9105')
        ORDER BY ref`,
      )
      .all() as { ref: string; open: number }[]
    expect(intervals).toEqual([
      { ref: 'orch:9104', open: 0 },
      { ref: 'orch:9105', open: 1 },
    ])
  })

  test('a failover from a resumed turn closes that turn under its root ref', async () => {
    const turns = [
      {
        id: 9107,
        started_at: '2026-09-03T00:00:00.000Z',
        latency_ms: null,
        vendor_tokens: null,
        vendor_cost_usd: null,
        status: 'running',
        turn: 2,
      },
    ]
    await ingestRunFixtures(runFixture({ id: 9106, turns }))
    await ingestRunFixtures(
      runFixture({
        id: 9108,
        retry_of: 9107,
        started_at: '2026-09-03T00:01:00.000Z',
      }),
    )

    const prior = db()
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = 'orch:9106:turn:9107'`)
      .get() as { open: number }
    expect(prior.open).toBe(0)
  })

  test('a resumed chain ingests each execution interval and conserves its tokens', async () => {
    const starts = [
      '2026-09-01T12:00:00.000Z',
      '2026-09-01T12:10:00.000Z',
      '2026-09-01T12:30:00.000Z',
      '2026-09-01T13:00:00.000Z',
      '2026-09-01T13:40:00.000Z',
    ]
    const latencies = [63_855, 11_127, 200_636, 52_916, 704_156]
    const tokens = [260_552, 62_612, 1_904_392, 261_452, 9_309_615]
    const turns = starts.map((started_at, index) => ({
      id: [1168, 1169, 1173, 1210, 1217][index]!,
      started_at,
      latency_ms: latencies[index]!,
      vendor_tokens: tokens[index]!,
      vendor_cost_usd: null,
      status: 'ok',
      turn: index + 1,
    }))

    // Replace the legacy root-wide interval just as the first post-change
    // collection must do for existing hub databases.
    await ingestRunFixtures(
      runFixture({
        id: 1168,
        started_at: starts[0],
        latency_ms: latencies[0],
        status: 'ok',
      }),
    )
    const result = await ingestRunFixtures(
      runFixture({
        id: 1168,
        started_at: starts[0],
        latency_ms: latencies[0],
        vendor_tokens: tokens[0],
        status: 'ok',
        turns,
      }),
    )

    const intervals = db()
      .query(
        `SELECT start_at, end_at, vendor_tokens, ref FROM interval
        WHERE source = 'orch' AND ref LIKE 'orch:1168%' ORDER BY start_at`,
      )
      .all() as { start_at: string; end_at: string; vendor_tokens: number; ref: string }[]
    expect(result).toEqual({ rows: 5, skipped: 0 })
    expect(intervals).toHaveLength(5)
    expect(intervals.every((row) => row.ref.startsWith('orch:1168:turn:'))).toBe(true)
    let vendorTokens = 0
    for (const row of intervals) vendorTokens += row.vendor_tokens
    expect(vendorTokens).toBe(11_798_623)
    expect(chainVendorTokens(runFixture({ turns }))).toBe(11_798_623)
    expect(engagedMs(executionSpans(runFixture({ turns })))).toBe(1_032_690)
    expect(
      engagedMs(
        intervals.map((row) => ({
          start: at(row.start_at),
          end: at(row.end_at),
        })),
      ),
    ).toBe(1_032_690)
    expect(human(1_032_690)).toBe('17m 13s')
  })

  test('copies started_by_user_id onto the orch interval and leaves a missing starter null', async () => {
    const starter = '01990000-0000-7000-8000-000000000123'
    await ingestRunFixtures(runFixture({ id: 9210, started_by_user_id: starter }))
    await ingestRunFixtures(runFixture({ id: 9211 }))
    expect(
      db()
        .query(`SELECT user_id FROM interval WHERE source = 'orch' AND ref = 'orch:9210'`)
        .get() as { user_id: string | null },
    ).toEqual({ user_id: starter })
    expect(
      db()
        .query(`SELECT user_id FROM interval WHERE source = 'orch' AND ref = 'orch:9211'`)
        .get() as { user_id: string | null },
    ).toEqual({ user_id: null })
  })

  test('stores session_id and every question on the interval and question table', async () => {
    const result = await ingestRunFixtures(
      runFixture({
        id: 9201,
        session_id: 'sess-a',
        questions: [
          { id: 11, run_id: 9201, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
          {
            id: 12,
            run_id: 9201,
            asked_at: '2026-09-04T18:00:00.000Z',
            answered_at: '2026-09-04T18:10:00.000Z',
          },
        ],
      }),
    )
    expect(result).toEqual({ rows: 1, skipped: 0 })

    const interval = db()
      .query(`SELECT session_id FROM interval WHERE source = 'orch' AND ref = 'orch:9201'`)
      .get() as { session_id: string }
    expect(interval.session_id).toBe('sess-a')

    const questions = db()
      .query(
        `SELECT question_id, run_ref, root_ref, task_key, session_id, asked_at, answered_at
         FROM question WHERE root_ref = 'orch:9201' ORDER BY question_id`,
      )
      .all() as {
      question_id: number
      run_ref: string
      root_ref: string
      task_key: string | null
      session_id: string | null
      asked_at: string
      answered_at: string | null
    }[]
    expect(questions).toEqual([
      {
        question_id: 11,
        run_ref: 'orch:9201',
        root_ref: 'orch:9201',
        task_key: 'ALP-118',
        session_id: 'sess-a',
        asked_at: '2026-09-04T19:00:00.000Z',
        answered_at: null,
      },
      {
        question_id: 12,
        run_ref: 'orch:9201',
        root_ref: 'orch:9201',
        task_key: 'ALP-118',
        session_id: 'sess-a',
        asked_at: '2026-09-04T18:00:00.000Z',
        answered_at: '2026-09-04T18:10:00.000Z',
      },
    ])
  })

  test('a bare probe object is a contract violation, not a skipped probe', async () => {
    const prior = '"2026-09-04T00:00:00.000Z"'
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO setting (key, value) VALUES ('collect.runs.at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(prior),
    )
    const beforeQuestions = (db().query(`SELECT COUNT(*) n FROM question`).get() as { n: number }).n

    await expect(ingestStdout('{"probe":1}\n')).rejects.toThrow('line 1 missing id')
    expect(collectRunsAt()).toBe(prior)
    expect((db().query(`SELECT COUNT(*) n FROM question`).get() as { n: number }).n).toBe(
      beforeQuestions,
    )
  })

  test('a malformed line refuses the whole batch and writes nothing', async () => {
    const prior = collectRunsAt()
    const good = runFixture({ id: 9601, session_id: 'sess-batch' })
    const bad = { ...runFixture({ id: 9602 }), started_at: undefined }
    delete (bad as { started_at?: string }).started_at

    await expect(ingestStdout(`${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`)).rejects.toThrow(
      'line 2 missing started_at',
    )
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:9601'`).get()).toBeNull()
    expect(db().query(`SELECT 1 FROM question WHERE root_ref = 'orch:9601'`).get()).toBeNull()
  })

  test('a probe carrying the full contract is skipped without writing', async () => {
    const result = await ingestRunFixtures(runFixture({ id: 9701, probe: 1 }))
    expect(result).toEqual({ rows: 0, skipped: 1 })
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:9701'`).get()).toBeNull()
  })

  test('questions:null is a contract violation', async () => {
    const prior = collectRunsAt()
    const row = { ...runFixture({ id: 10101 }), questions: null }
    await expect(ingestStdout(`${JSON.stringify(row)}\n`)).rejects.toThrow(
      'line 1 missing questions',
    )
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:10101'`).get()).toBeNull()
    expect(db().query(`SELECT 1 FROM question WHERE root_ref = 'orch:10101'`).get()).toBeNull()
  })

  test('a complete run lacking only questions is a contract violation', async () => {
    const prior = collectRunsAt()
    const row = { ...runFixture({ id: 10105 }) }
    delete (row as { questions?: unknown }).questions
    await expect(ingestStdout(`${JSON.stringify(row)}\n`)).rejects.toThrow(
      'line 1 missing questions',
    )
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM interval WHERE ref = 'orch:10105'`).get()).toBeNull()
    expect(db().query(`SELECT 1 FROM question WHERE root_ref = 'orch:10105'`).get()).toBeNull()
  })

  test('a question missing answered_at refuses the batch', async () => {
    const prior = collectRunsAt()
    await expect(
      ingestRunFixtures(
        runFixture({
          id: 10102,
          questions: [{ id: 71, run_id: 10102, asked_at: '2026-09-04T19:00:00.000Z' }],
        }),
      ),
    ).rejects.toThrow('line 1 missing questions[0].answered_at')
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM question WHERE question_id = 71`).get()).toBeNull()
  })

  test('an invalid asked_at refuses the batch', async () => {
    const prior = collectRunsAt()
    await expect(
      ingestRunFixtures(
        runFixture({
          id: 10103,
          questions: [{ id: 72, run_id: 10103, asked_at: 'not-a-date', answered_at: null }],
        }),
      ),
    ).rejects.toThrow('line 1 missing questions[0].asked_at')
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM question WHERE question_id = 72`).get()).toBeNull()
  })

  test('a run_id outside the published root and turns refuses the batch', async () => {
    const prior = collectRunsAt()
    await expect(
      ingestRunFixtures(
        runFixture({
          id: 10104,
          questions: [
            { id: 73, run_id: 999, asked_at: '2026-09-04T19:00:00.000Z', answered_at: null },
          ],
        }),
      ),
    ).rejects.toThrow('line 1 missing questions[0].run_id')
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM question WHERE question_id = 73`).get()).toBeNull()
  })
})
