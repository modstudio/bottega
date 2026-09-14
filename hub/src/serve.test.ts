import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { db } from './db.ts'
import { clearOrchCache, view } from './serve.ts'
import { ingestRunFixtures, resetFixtureStore, runFixture } from '../test/run-fixtures.ts'

beforeAll(resetFixtureStore)
afterEach(clearOrchCache)

describe('run ingest', () => {
  test('launch_key beats a contradicting prompt in ingest and the runs view', async () => {
    const run = runFixture({
      id: 9801,
      cwd: '/fixtures/repos/workshop',
      prompt_head: 'Implement LOC-2000',
      launch_key: 'DEV-3000',
      latency_ms: 1000,
      status: 'ok',
    })
    await ingestRunFixtures(run)
    const interval = db().query(
      `SELECT task_key, via FROM interval WHERE ref = 'orch:9801'`,
    ).get() as { task_key: string; via: string }
    expect(interval).toEqual({ task_key: 'DEV-3000', via: 'launch_key' })

    const state = {
      live: [], stale: 0, matrix: [], guide: [], health: [],
      totals: { runs: 1, failed: 0, stale_n: 0, toks: 0, scored: 1 },
      unscored: 0, spawns: [], agents: [], byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([argv.includes('runs') ? JSON.stringify(run) : JSON.stringify(state)]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = await view('runs', 24) as { rows: { id: number; task: string | null }[] }
      expect(result.rows).toEqual([expect.objectContaining({ id: 9801, task: 'DEV-3000' })])
    } finally {
      spawn.mockRestore()
    }
  })

  test('the runs view passes evidence_excluded through to the list', async () => {
    const run = runFixture({
      id: 9821,
      status: 'ok',
      delivery: 'none',
      evidence_excluded: 'voided with orch score --void',
    })
    const state = {
      live: [], stale: 0, matrix: [], guide: [], health: [],
      totals: { runs: 1, failed: 0, stale_n: 0, toks: 0, scored: 0, voided: 1 },
      unscored: 0, spawns: [], agents: [], byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([argv.includes('runs') ? JSON.stringify(run) : JSON.stringify(state)]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = await view('runs', 24) as {
        totals: { scored: number; voided: number }
        rows: { id: number; evidence_excluded: string | null; delivery: string | null }[]
      }
      expect(result.totals).toEqual(expect.objectContaining({ scored: 0, voided: 1 }))
      expect(result.rows).toEqual([expect.objectContaining({
        id: 9821,
        delivery: 'none',
        evidence_excluded: 'voided with orch score --void',
      })])
    } finally {
      spawn.mockRestore()
    }
  })

  test('the runs view reports vendor tokens per agent without a combined total', async () => {
    const runs = [
      runFixture({ id: 9811, agent: 'grok', vendor_tokens: 1_200_000 }),
      runFixture({ id: 9812, agent: 'codex', vendor_tokens: 340_000 }),
    ]
    const state = {
      live: [], stale: 0, matrix: [], guide: [], health: [],
      totals: { runs: 2, failed: 0, stale_n: 0, toks: 1_540_000, scored: 2 },
      unscored: 0, spawns: [], agents: [], byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([
        argv.includes('runs')
          ? runs.map((run) => JSON.stringify(run)).join('\n')
          : JSON.stringify(state),
      ]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = await view('runs', 24) as {
        totals: Record<string, number>
        vendors: { agent: string; tokens: number }[]
      }
      expect(result.totals).not.toHaveProperty('toks')
      expect(result.vendors).toEqual([
        { agent: 'grok', tokens: 1_200_000 },
        { agent: 'codex', tokens: 340_000 },
      ])
    } finally {
      spawn.mockRestore()
    }
  })
})
