import { beforeAll, describe, expect, test } from 'bun:test'
import { engagedMs, human } from '../../../shared/interval.ts'
import {
  at,
  collectRunsAt,
  fixtureRecordId,
  ingestRunFixtures,
  ingestStdout,
  questionFixture,
  resetFixtureStore,
  runFixture,
} from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { runRef } from '../run-ref.ts'
import { chainVendorTokens, convertLegacyRunRefs, executionSpans } from './runs.ts'

beforeAll(resetFixtureStore)

const ref = (id: number) => `orch:${fixtureRecordId(id)}`
const turnRef = (root: number, turn: number) => `${ref(root)}:turn:${fixtureRecordId(turn)}`
const identityMap = (run: ReturnType<typeof runFixture>) => [
  { number: run.number, record_id: run.record_id },
  ...(run.turns ?? []).map((turn) => ({ number: turn.number, record_id: turn.record_id })),
]

describe('run ingest', () => {
  test('numeric refs convert across every hub table and one unmapped value rolls back', async () => {
    const run = runFixture({
      id: 9080,
      turns: [runFixture({ id: 9081, turn: 2 })],
      questions: [
        questionFixture({
          id: 9080,
          run_id: 9081,
          deliveries: [
            {
              id: 1,
              question_id: 9080,
              run_id: 9081,
              mode: 'resume',
              outcome: 'delivered',
              at: '2026-09-04T19:04:00.000Z',
              error: null,
            },
          ],
        }),
      ],
    })
    await ingestRunFixtures(run)
    const intervalRef = turnRef(9080, 9081)
    const original = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM interval WHERE ref=?')
      .get(intervalRef)!.record_id
    const report = writeTransaction((conn) => {
      conn.query('UPDATE interval SET ref=? WHERE ref=?').run('orch:9080:turn:9081', intervalRef)
      conn
        .query('UPDATE question SET run_ref=?,root_ref=? WHERE number=?')
        .run('orch:9080:turn:9081', 'orch:9080', 9080)
      conn
        .query(
          'UPDATE question_delivery SET run_ref=? WHERE question_record_id=(SELECT record_id FROM question WHERE number=?)',
        )
        .run('orch:9080:turn:9081', 9080)
      return convertLegacyRunRefs(conn, identityMap(run))
    })
    expect(report).toEqual({ interval: 1, question: 2, question_delivery: 1 })
    expect(
      db()
        .query<{ record_id: string }, [string]>('SELECT record_id FROM interval WHERE ref=?')
        .get(intervalRef)?.record_id,
    ).toBe(original)
    expect(db().query('SELECT run_ref,root_ref FROM question WHERE number=?').get(9080)).toEqual({
      run_ref: turnRef(9080, 9081),
      root_ref: ref(9080),
    })
    expect(
      db()
        .query(
          'SELECT run_ref FROM question_delivery WHERE question_record_id=(SELECT record_id FROM question WHERE number=?)',
        )
        .get(9080),
    ).toEqual({ run_ref: turnRef(9080, 9081) })

    expect(() =>
      writeTransaction((conn) => {
        conn.query('UPDATE interval SET ref=? WHERE ref=?').run('orch:9080:turn:9081', intervalRef)
        conn.query('UPDATE question SET root_ref=? WHERE number=?').run('orch:99999', 9080)
        return convertLegacyRunRefs(conn, identityMap(run))
      }),
    ).toThrow('numeric run refs have no orchestrator UUID mapping')
    expect(
      db()
        .query<{ ref: string }, [string]>('SELECT ref FROM interval WHERE record_id=?')
        .get(original),
    ).toEqual({ ref: intervalRef })
    expect(db().query('SELECT root_ref FROM question WHERE number=?').get(9080)).toEqual({
      root_ref: ref(9080),
    })
    writeTransaction((conn) => {
      conn.query('DELETE FROM question WHERE number=?').run(9080)
      conn.query('DELETE FROM interval WHERE ref LIKE ?').run(`${ref(9080)}%`)
    })
  })
  test('legacy conversion is fed by the narrow run identity mapping', async () => {
    const run = runFixture({
      id: 9082,
      turns: [runFixture({ id: 9083, turn: 2 })],
      questions: [questionFixture({ id: 9082, run_id: 9083 })],
    })
    await ingestRunFixtures(run)
    writeTransaction((conn) => {
      conn
        .query('UPDATE interval SET ref=? WHERE ref=?')
        .run('orch:9082:turn:9083', turnRef(9082, 9083))
      conn
        .query('UPDATE question SET run_ref=?,root_ref=? WHERE number=?')
        .run('orch:9082:turn:9083', 'orch:9082', 9082)
    })

    await ingestStdout(JSON.stringify(run), '[]', JSON.stringify(identityMap(run)))

    expect(db().query('SELECT run_ref,root_ref FROM question WHERE number=?').get(9082)).toEqual({
      run_ref: turnRef(9082, 9083),
      root_ref: ref(9082),
    })
    writeTransaction((conn) => {
      conn.query('DELETE FROM question WHERE number=?').run(9082)
      conn.query('DELETE FROM interval WHERE ref LIKE ?').run(`${ref(9082)}%`)
    })
  })
  test('the interval writer and UUID ref parser round-trip root and turn identities', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9090,
        turns: [runFixture({ id: 9090, turn: 1 }), runFixture({ id: 9091, turn: 2 })],
      }),
    )
    const refs = db()
      .query<{ ref: string }, []>("SELECT ref FROM interval WHERE source='orch' ORDER BY ref")
      .all()
    expect(refs.map(({ ref }) => runRef(ref))).toEqual([
      { root: fixtureRecordId(9090), turn: fixtureRecordId(9090) },
      { root: fixtureRecordId(9090), turn: fixtureRecordId(9091) },
    ])
  })
  test('workflow rulings ingest with nullable run provenance', async () => {
    await ingestStdout(
      '',
      JSON.stringify([
        {
          id: 8001,
          record_id: '00000000-0000-4000-8000-000000008001',
          run_number: null,
          run_record_id: null,
          workflow_cursor_id: '00000000-0000-4000-8000-000000007001',
          workflow_key: 'DEV-964',
          project: 'alpha',
          workflow_slug: 'ship',
          mode_slug: 'default',
          session_id: 'owner',
          asked_at: '2026-09-24T12:00:00.000Z',
          question: 'Proceed?',
          answer: 'Yes',
          answer_basis: 'specification line 4',
          answered_at: '2026-09-24T12:01:00.000Z',
          answered_by: 'owner',
          asked_via: 'workflow',
          answerer_kind: 'agent',
          answer_channel: 'cli',
          closed_at: null,
          close_reason: null,
          overturned_at: null,
          overturned_by: null,
          overturn_reason: null,
          replacement: null,
          filed_as: null,
          filed_ref: null,
          filed_record_id: null,
          filed_label: null,
          filed_at: null,
        },
      ]),
    )
    expect(
      db()
        .query(
          `SELECT run_ref,root_ref,workflow_cursor_id,workflow_key,project,asked_via
           FROM question WHERE number=8001`,
        )
        .get(),
    ).toEqual({
      run_ref: null,
      root_ref: null,
      workflow_cursor_id: '00000000-0000-4000-8000-000000007001',
      workflow_key: 'DEV-964',
      project: 'alpha',
      asked_via: 'workflow',
    })
  })

  test('a second collect of an unchanged run keeps the interval UUID', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9100,
        started_at: '2026-09-03T00:00:00.000Z',
        latency_ms: 1000,
        status: 'ok',
      }),
    )
    const first = db()
      .query<{ record_id: string }, []>(
        `SELECT record_id FROM interval WHERE source = 'orch' AND ref = '${ref(9100)}'`,
      )
      .get()
    if (!first) throw new Error('expected an interval after the first collect')
    await ingestRunFixtures(
      runFixture({
        id: 9100,
        started_at: '2026-09-03T00:00:00.000Z',
        latency_ms: 1000,
        status: 'ok',
      }),
    )
    expect(
      db()
        .query<{ record_id: string }, []>(
          `SELECT record_id FROM interval WHERE source = 'orch' AND ref = '${ref(9100)}'`,
        )
        .all(),
    ).toEqual([first])
  })

  test('re-ingesting a run keeps the project corrected from its task prefix', async () => {
    const run = runFixture({
      id: 9199,
      repo: 'temporary',
      cwd: '/fixtures/repos/temporary',
      launch_key: 'ALP-118',
    })
    await ingestRunFixtures(run)
    await ingestRunFixtures(run)
    expect(
      db()
        .query<{ project: string; task_key: string }, []>(
          `SELECT project,task_key FROM interval WHERE source='orch' AND ref='${ref(9199)}'`,
        )
        .all(),
    ).toEqual([{ project: 'alpha', task_key: 'ALP-118' }])
  })

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
        `SELECT agent, start_at, open FROM interval WHERE source = 'orch' AND ref = '${ref(9101)}'`,
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
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = '${ref(9102)}'`)
      .all() as { open: number }[]
    expect(intervals).toEqual([{ open: 0 }])
    expect(result).toEqual({ rows: 0, skipped: 1 })
  })

  test('an in-flight run stays open', async () => {
    const result = await ingestRunFixtures(runFixture({ id: 9103 }))

    const interval = db()
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = '${ref(9103)}'`)
      .get() as { open: number }
    expect(interval.open).toBe(1)
    expect(result).toEqual({ rows: 1, skipped: 0 })
  })

  test('a failover successor closes the execution interval it replaced', async () => {
    await ingestRunFixtures(runFixture({ id: 9104 }))
    await ingestRunFixtures(
      runFixture({
        id: 9105,
        retry_record_id: fixtureRecordId(9104),
        started_at: '2026-09-03T00:01:00.000Z',
      }),
    )

    const intervals = db()
      .query(
        `SELECT ref, open FROM interval
        WHERE source = 'orch' AND ref IN ('${ref(9104)}', '${ref(9105)}')
        ORDER BY ref`,
      )
      .all() as { ref: string; open: number }[]
    expect(intervals).toEqual([
      { ref: ref(9104), open: 0 },
      { ref: ref(9105), open: 1 },
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
        retry_record_id: fixtureRecordId(9107),
        started_at: '2026-09-03T00:01:00.000Z',
      }),
    )

    const prior = db()
      .query(`SELECT open FROM interval WHERE source = 'orch' AND ref = '${turnRef(9106, 9107)}'`)
      .get() as { open: number }
    expect(prior.open).toBe(0)
  })

  test('a listed terminal turn with unreadable latency keeps its existing interval', async () => {
    const readable = {
      id: 9110,
      started_at: '2026-09-03T00:00:00.000Z',
      latency_ms: null,
      vendor_tokens: null,
      vendor_cost_usd: null,
      status: 'running',
      turn: 1,
    }
    await ingestRunFixtures(runFixture({ id: 9110, turns: [readable] }))
    const before = db()
      .query<{ record_id: string }, []>(
        `SELECT record_id FROM interval WHERE source='orch' AND ref='${turnRef(9110, 9110)}'`,
      )
      .get()!

    const unreadable = { ...readable, status: 'done' }
    await ingestRunFixtures(runFixture({ id: 9110, turns: [unreadable] }))
    expect(
      db()
        .query<{ record_id: string }, []>(
          `SELECT record_id FROM interval WHERE source='orch' AND ref='${turnRef(9110, 9110)}'`,
        )
        .get(),
    ).toEqual(before)

    await ingestRunFixtures(runFixture({ id: 9110, turns: [] }))
    expect(
      db()
        .query(`SELECT 1 FROM interval WHERE source='orch' AND ref='${turnRef(9110, 9110)}'`)
        .get(),
    ).toBeNull()
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
    const turns = starts.map((startedAt, index) => ({
      id: [1168, 1169, 1173, 1210, 1217][index]!,
      started_at: startedAt,
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
        WHERE source = 'orch' AND ref LIKE '${ref(1168)}%' ORDER BY start_at`,
      )
      .all() as { start_at: string; end_at: string; vendor_tokens: number; ref: string }[]
    expect(result).toEqual({ rows: 5, skipped: 0 })
    expect(intervals).toHaveLength(5)
    expect(intervals.every((row) => row.ref.startsWith(`${ref(1168)}:turn:`))).toBe(true)
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

  test('copies started_by_user_id onto the orchestrator interval and leaves a missing starter null', async () => {
    const starter = '01990000-0000-7000-8000-000000000123'
    await ingestRunFixtures(runFixture({ id: 9210, started_by_user_id: starter }))
    await ingestRunFixtures(runFixture({ id: 9211 }))
    expect(
      db()
        .query(`SELECT user_id FROM interval WHERE source = 'orch' AND ref = '${ref(9210)}'`)
        .get() as { user_id: string | null },
    ).toEqual({ user_id: starter })
    expect(
      db()
        .query(`SELECT user_id FROM interval WHERE source = 'orch' AND ref = '${ref(9211)}'`)
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
      .query(`SELECT session_id FROM interval WHERE source = 'orch' AND ref = '${ref(9201)}'`)
      .get() as { session_id: string }
    expect(interval.session_id).toBe('sess-a')

    const questions = db()
      .query(
        `SELECT number, run_ref, root_ref, task_key, session_id, asked_at, answered_at
         FROM question WHERE root_ref = '${ref(9201)}' ORDER BY number`,
      )
      .all() as {
      number: number
      run_ref: string
      root_ref: string
      task_key: string | null
      session_id: string | null
      asked_at: string
      answered_at: string | null
    }[]
    expect(questions).toEqual([
      {
        number: 11,
        run_ref: ref(9201),
        root_ref: ref(9201),
        task_key: 'ALP-118',
        session_id: 'sess-a',
        asked_at: '2026-09-04T19:00:00.000Z',
        answered_at: null,
      },
      {
        number: 12,
        run_ref: ref(9201),
        root_ref: ref(9201),
        task_key: 'ALP-118',
        session_id: 'sess-a',
        asked_at: '2026-09-04T18:00:00.000Z',
        answered_at: '2026-09-04T18:10:00.000Z',
      },
    ])
  })

  test('maps question provenance and replaces deliveries on re-ingest', async () => {
    const base = runFixture({
      id: 9250,
      turns: [
        {
          id: 9251,
          started_at: '2026-09-04T19:01:00.000Z',
          latency_ms: 1000,
          vendor_tokens: null,
          vendor_cost_usd: null,
          status: 'delivered',
          turn: 2,
        },
      ],
      questions: [
        questionFixture({
          id: 50,
          run_id: 9250,
          asked_at: '2026-09-04T19:00:00.000Z',
          answered_at: '2026-09-04T19:01:00.000Z',
          asked_via: 'reply',
          answerer_kind: 'operator',
          answer_channel: 'cli',
          overturned_at: '2026-09-05T13:00:00.000Z',
          deliveries: [
            {
              id: 1,
              question_id: 50,
              run_id: 9251,
              mode: 'resume',
              outcome: 'failed',
              at: '2026-09-04T19:02:00.000Z',
              error: 'resume failed',
            },
            {
              id: 2,
              question_id: 50,
              run_id: 9260,
              mode: 'retry',
              outcome: 'delivered',
              at: '2026-09-04T19:03:00.000Z',
              error: null,
            },
          ],
        }),
      ],
    })
    await ingestRunFixtures(base)

    expect(
      db()
        .query(
          `SELECT asked_via, answerer_kind, answer_channel, overturned_at FROM question WHERE number = 50`,
        )
        .get(),
    ).toEqual({
      asked_via: 'reply',
      answerer_kind: 'operator',
      answer_channel: 'cli',
      overturned_at: '2026-09-05T13:00:00.000Z',
    })
    expect(
      db()
        .query(
          `SELECT d.run_ref, d.mode, d.outcome, d.at, d.error FROM question_delivery d
           JOIN question q ON q.record_id=d.question_record_id WHERE q.number = 50 ORDER BY d.at`,
        )
        .all(),
    ).toEqual([
      {
        run_ref: turnRef(9250, 9251),
        mode: 'resume',
        outcome: 'failed',
        at: '2026-09-04T19:02:00.000Z',
        error: 'resume failed',
      },
      {
        run_ref: ref(9260),
        mode: 'retry',
        outcome: 'delivered',
        at: '2026-09-04T19:03:00.000Z',
        error: null,
      },
    ])

    const updatedQuestion = {
      ...base.questions[0]!,
      deliveries: [
        {
          id: 3,
          question_id: 50,
          question_record_id: base.questions[0]!.record_id,
          run_number: null,
          run_record_id: null,
          mode: 'record-only' as const,
          outcome: 'delivered' as const,
          at: '2026-09-04T19:04:00.000Z',
          error: null,
        },
      ],
    }
    await ingestRunFixtures({ ...base, questions: [updatedQuestion] })
    expect(
      db()
        .query(
          `SELECT d.run_ref, d.mode, d.outcome, d.at, d.error FROM question_delivery d
           JOIN question q ON q.record_id=d.question_record_id WHERE q.number = 50`,
        )
        .all(),
    ).toEqual([
      {
        run_ref: null,
        mode: 'record-only',
        outcome: 'delivered',
        at: '2026-09-04T19:04:00.000Z',
        error: null,
      },
    ])
  })

  test('stores a retired record-only delivery alongside other rows in one batch', async () => {
    await ingestRunFixtures(
      runFixture({
        id: 9270,
        questions: [
          questionFixture({
            id: 61,
            run_id: 9270,
            deliveries: [
              {
                id: 1,
                question_id: 61,
                run_id: null,
                mode: 'record-only',
                outcome: 'retired',
                at: '2026-09-04T19:04:00.000Z',
                error: 'chain-terminal',
              },
            ],
          }),
          questionFixture({
            id: 62,
            run_id: 9270,
            deliveries: [
              {
                id: 2,
                question_id: 62,
                run_id: 9270,
                mode: 'live',
                outcome: 'delivered',
                at: '2026-09-04T19:05:00.000Z',
                error: null,
              },
            ],
          }),
        ],
      }),
    )

    expect(
      db()
        .query(
          `SELECT q.number,d.run_ref,d.mode,d.outcome,d.error FROM question_delivery d
           JOIN question q ON q.record_id=d.question_record_id
           WHERE q.number IN (61,62) ORDER BY q.number`,
        )
        .all(),
    ).toEqual([
      {
        number: 61,
        run_ref: null,
        mode: 'record-only',
        outcome: 'retired',
        error: 'chain-terminal',
      },
      {
        number: 62,
        run_ref: ref(9270),
        mode: 'live',
        outcome: 'delivered',
        error: null,
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

    await expect(ingestStdout('{"probe":1}\n')).rejects.toThrow('line 1 missing number')
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
    expect(db().query(`SELECT 1 FROM question WHERE number = 71`).get()).toBeNull()
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
    expect(db().query(`SELECT 1 FROM question WHERE number = 72`).get()).toBeNull()
  })

  test('a run_number outside the published root and turns refuses the batch', async () => {
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
    ).rejects.toThrow('line 1 missing questions[0].run_record_id')
    expect(collectRunsAt()).toBe(prior)
    expect(db().query(`SELECT 1 FROM question WHERE number = 73`).get()).toBeNull()
  })
})
