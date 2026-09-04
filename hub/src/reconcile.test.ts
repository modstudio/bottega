import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hub-reconcile-'))
process.env.HUB_DB = join(dir, 'hub.db')
const { db } = await import('./db.ts')
const { reconcileOpenIntervals } = await import('./reconcile.ts')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function add(id: number, ref: string, endAt: string) {
  db().query(
    `INSERT INTO interval
       (id, source, start_at, end_at, ref, open, claude_tokens, vendor_tokens)
     VALUES (?, 'orch', '2026-09-03T00:00:00.000Z', ?, ?, 1, 0, 0)`,
  ).run(id, endAt, ref)
}

function orchAnswers(rows: object[]) {
  return spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    expect(args).toEqual([
      expect.stringContaining('/bin/orch'), 'runs', '--json',
      '--id', '1205', '--id', '1206', '--id', '9999',
    ])
    expect(args).not.toContain('--since')
    return {
      stdout: new Blob([rows.map((row) => JSON.stringify(row)).join('\n')]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
    }
  }) as unknown as typeof Bun.spawn)
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
        dryRun: true, now: new Date('2026-09-03T02:00:01.000Z').getTime(),
      })
      expect(result.closed.map((row) => [row.id, row.status, row.removesMs]))
        .toEqual([[1, 'ok', 7_200_000]])
      expect(result.leftOpen.map((row) => [row.id, row.reason])).toEqual([
        [2, 'run 1206 is still running'],
        [3, 'run 9999 is unknown to orch; needs a decision'],
      ])
      expect(db().query('SELECT id, open FROM interval ORDER BY id').all()).toEqual([
        { id: 1, open: 1 }, { id: 2, open: 1 }, { id: 3, open: 1 },
      ])
    } finally { spawn.mockRestore() }
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
      expect(db().query('SELECT open, end_at FROM interval WHERE id = 1').get())
        .toEqual({ open: 0, ...(before as { end_at: string }) })
    } finally { spawn.mockRestore() }

    const secondSpawn = spyOn(Bun, 'spawn').mockImplementation((() => ({
      stdout: new Blob([
        [
          { id: 1206, status: 'running' },
          { id: 9999, status: 'unknown', unknown: true },
        ].map((row) => JSON.stringify(row)).join('\n'),
      ]),
      stderr: new Blob(['']), exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn)
    try {
      const second = await reconcileOpenIntervals()
      expect(second.closed).toEqual([])
      expect(second.leftOpen).toHaveLength(2)
    } finally { secondSpawn.mockRestore() }
  })
})
