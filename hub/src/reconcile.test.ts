import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { encodeOrchRunLine } from '../../shared/orch-contract.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'

const { db } = await import('./db.ts')
const { reconcileOpenIntervals } = await import('./reconcile.ts')

beforeAll(resetFixtureStore)

function add(id: number, ref: string, endAt: string) {
  db()
    .query(
      `INSERT INTO interval
       (id, source, start_at, end_at, ref, open, claude_tokens, vendor_tokens)
     VALUES (?, 'orch', '2026-09-03T00:00:00.000Z', ?, ?, 1, 0, 0)`,
    )
    .run(id, endAt, ref)
}

function orchAnswers(rows: object[]) {
  return spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    expect(args).toEqual([
      expect.any(String),
      'runs',
      '--json',
      '--id',
      '1205',
      '--id',
      '1206',
      '--id',
      '9999',
    ])
    expect(args).not.toContain('--since')
    return {
      stdout: new Blob([rows.map(runLine).join('\n')]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
    }
  }) as unknown as typeof Bun.spawn)
}

function runLine(row: object): string {
  if ('unknown' in row) return encodeOrchRunLine(row)
  const value = row as { id: number; status: string }
  return encodeOrchRunLine({
    id: value.id,
    started_at: '2026-09-03T00:00:00.000Z',
    agent: 'codex',
    job: 'implement',
    repo: null,
    cwd: null,
    session_id: null,
    latency_ms: null,
    vendor_tokens: null,
    vendor_cost_usd: null,
    prompt_head: '',
    prompt_path: null,
    branch: null,
    probe: 0,
    status: value.status,
    delivery: null,
    quality: null,
    retry_of: null,
    turns: [
      {
        id: value.id,
        started_at: '2026-09-03T00:00:00.000Z',
        latency_ms: null,
        vendor_tokens: null,
        vendor_cost_usd: null,
        status: value.status,
        turn: 1,
      },
    ],
    questions: [],
    launch_key: null,
  })
}

describe('open interval reconciliation', () => {
  test('dry-run reports terminal, live, and unknown rows without writing', async () => {
    add(1, 'orch:1205', '2026-09-03T00:00:01.000Z')
    add(2, 'orch:1206', '2026-09-03T00:00:02.000Z')
    add(3, 'orch:9999', '2026-09-03T00:00:03.000Z')
    const spawn = orchAnswers([
      { id: 1205, status: 'ok' },
      { id: 1206, status: 'running' },
      { id: 9999, status: 'unknown', unknown: true },
    ])
    try {
      const result = await reconcileOpenIntervals({
        dryRun: true,
        now: new Date('2026-09-03T02:00:01.000Z').getTime(),
      })
      expect(result.closed.map((row) => [row.id, row.status, row.removesMs])).toEqual([
        [1, 'ok', 7_200_000],
      ])
      expect(result.leftOpen.map((row) => [row.id, row.reason])).toEqual([
        [2, 'run 1206 is still running'],
        [3, 'run 9999 is unknown to orch; needs a decision'],
      ])
      expect(db().query('SELECT id, open FROM interval ORDER BY id').all()).toEqual([
        { id: 1, open: 1 },
        { id: 2, open: 1 },
        { id: 3, open: 1 },
      ])
    } finally {
      spawn.mockRestore()
    }
  })

  test('a real run closes terminal rows, preserves end_at, and is idempotent', async () => {
    const spawn = orchAnswers([
      { id: 1205, status: 'ok' },
      { id: 1206, status: 'running' },
      { id: 9999, status: 'unknown', unknown: true },
    ])
    try {
      const before = db().query('SELECT end_at FROM interval WHERE id = 1').get()
      const first = await reconcileOpenIntervals()
      expect(first.closed.map((row) => row.id)).toEqual([1])
      expect(db().query('SELECT open, end_at FROM interval WHERE id = 1').get()).toEqual({
        open: 0,
        ...(before as { end_at: string }),
      })
    } finally {
      spawn.mockRestore()
    }

    const secondSpawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new Blob([
        [
          { id: 1206, status: 'running' },
          { id: 9999, status: 'unknown', unknown: true },
        ]
          .map(runLine)
          .join('\n'),
      ]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn)
    try {
      const second = await reconcileOpenIntervals()
      expect(second.closed).toEqual([])
      expect(second.leftOpen).toHaveLength(2)
    } finally {
      secondSpawn.mockRestore()
    }
  })
})
