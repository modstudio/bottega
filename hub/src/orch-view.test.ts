import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  fixtureRecordId,
  ingestRunFixtures,
  resetFixtureStore,
  runFixture,
} from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { clearOrchCache, TtlCache, view } from './orch-view.ts'

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
    const interval = db()
      .query('SELECT task_key, via FROM interval WHERE ref = ?')
      .get(`orch:${fixtureRecordId(9801)}`) as { task_key: string; via: string }
    expect(interval).toEqual({ task_key: 'DEV-3000', via: 'launch_key' })

    const state = {
      live: [],
      stale: 0,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 1, failed: 0, stale_n: 0, toks: 0, scored: 1 },
      unscored: 0,
      spawns: [],
      agents: [],
      byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([argv.includes('list') ? JSON.stringify(run) : JSON.stringify(state)]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = (await view('runs', 24)) as { rows: { id: number; task: string | null }[] }
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
      evidence_excluded: `voided with ${PLATFORM_SLUG} score --void`,
    })
    const state = {
      live: [],
      stale: 0,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 1, failed: 0, stale_n: 0, toks: 0, scored: 0, voided: 1 },
      unscored: 0,
      spawns: [],
      agents: [],
      byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([argv.includes('list') ? JSON.stringify(run) : JSON.stringify(state)]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = (await view('runs', 24)) as {
        totals: { scored: number; voided: number }
        rows: { id: number; evidence_excluded: string | null; delivery: string | null }[]
      }
      expect(result.totals).toEqual(expect.objectContaining({ scored: 0, voided: 1 }))
      expect(result.rows).toEqual([
        expect.objectContaining({
          id: 9821,
          delivery: 'none',
          evidence_excluded: `voided with ${PLATFORM_SLUG} score --void`,
        }),
      ])
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
      live: [],
      stale: 0,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 2, failed: 0, stale_n: 0, toks: 1_540_000, scored: 2 },
      unscored: 0,
      spawns: [],
      agents: [],
      byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([
        argv.includes('list')
          ? runs.map((run) => JSON.stringify(run)).join('\n')
          : JSON.stringify(state),
      ]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = (await view('runs', 24)) as {
        totals: Record<string, number>
        vendors: { agent: string; tokens: number; runs: number }[]
      }
      expect(result.totals).not.toHaveProperty('toks')
      expect(result.vendors).toEqual([
        { agent: 'grok', tokens: 1_200_000, runs: 1 },
        { agent: 'codex', tokens: 340_000, runs: 1 },
      ])
    } finally {
      spawn.mockRestore()
    }
  })

  test('search narrows rows and matched but leaves totals and facets unchanged', async () => {
    const runs = [
      runFixture({
        id: 9101,
        agent: 'grok',
        launch_key: 'DEV-3000',
        prompt_head: 'Implement DEV-3000',
        status: 'ok',
        delivery: 'full',
        vendor_tokens: 1_200,
      }),
      runFixture({
        id: 9102,
        agent: 'codex',
        launch_key: 'DEV-3001',
        prompt_head: 'Implement DEV-3001',
        status: 'ok',
        delivery: 'partial',
        vendor_tokens: 340,
      }),
    ]
    const state = {
      live: [],
      stale: 0,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 99, failed: 0, stale_n: 0, toks: 1_540, scored: 2 },
      unscored: 7,
      spawns: [],
      agents: [],
      byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([
        argv.includes('list')
          ? runs.map((run) => JSON.stringify(run)).join('\n')
          : JSON.stringify(state),
      ]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const whole = (await view('runs', 24)) as {
        totals: Record<string, number>
        unscored: number
        facets: { agents: string[]; projects: string[] }
        vendors: { agent: string; tokens: number }[]
        matched: number
        rows: { id: number; agent: string }[]
      }
      const searched = (await view('runs', 24, {
        agent: '',
        project: '',
        search: 'codex',
      })) as typeof whole
      expect(searched.matched).toBe(1)
      expect(searched.rows).toEqual([expect.objectContaining({ id: 9102, agent: 'codex' })])
      expect(searched.totals).toEqual(whole.totals)
      expect(searched.facets).toEqual(whole.facets)
      expect(searched.vendors).toEqual(whole.vendors)
      expect(searched.unscored).toBe(whole.unscored)
      expect(whole.matched).toBe(2)
      const empty = (await view('runs', 24, {
        agent: '',
        project: '',
        search: 'zzzz-no-match',
        offset: 75,
      })) as { matched: number; offset: number; rows: unknown[] }
      expect(empty.matched).toBe(0)
      expect(empty.offset).toBe(0)
      expect(empty.rows).toEqual([])
    } finally {
      spawn.mockRestore()
    }
  })

  test('an offset past the end returns the last page', async () => {
    const runs = Array.from({ length: 26 }, (_, index) =>
      runFixture({
        id: 9901 + index,
        launch_key: `DEV-${4000 + index}`,
        prompt_head: `Implement DEV-${4000 + index}`,
        status: 'ok',
        latency_ms: 1000,
      }),
    )
    const state = {
      live: [],
      stale: 0,
      matrix: [],
      guide: [],
      health: [],
      totals: { runs: 26, failed: 0, stale_n: 0, toks: 0, scored: 26 },
      unscored: 0,
      spawns: [],
      agents: [],
      byRepo: [],
    }
    const spawn = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => ({
      stdout: new Blob([
        argv.includes('list')
          ? runs.map((run) => JSON.stringify(run)).join('\n')
          : JSON.stringify(state),
      ]),
      stderr: new Blob(['']),
      exited: Promise.resolve(0),
      kill() {},
    })) as unknown as typeof Bun.spawn)
    try {
      const result = (await view('runs', 24, {
        agent: '',
        project: '',
        offset: 1000,
        limit: 25,
      })) as { offset: number; limit: number; matched: number; rows: { id: number }[] }
      expect(result.matched).toBe(26)
      expect(result.limit).toBe(25)
      expect(result.offset).toBe(25)
      expect(result.rows).toEqual([expect.objectContaining({ id: 9926 })])
      expect(result.rows).toHaveLength(1)
    } finally {
      spawn.mockRestore()
    }
  })
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('orchestrator procedure cache', () => {
  test('two clients polling for 60 seconds spawn at most once in each TTL window', async () => {
    let now = 0
    const spawns = new Map<string, number>()
    const cache = new TtlCache(30_000, () => now)
    const procedures = ['runs', 'routing', 'blockers', 'catalog:jobs', 'catalog:agents']
    const procedure = (name: string, client: string) =>
      cache.get(`response:${name}:${client}`, async () => ({
        client,
        data: await cache.get(`orch:${name}`, async () => {
          const spawn = (spawns.get(name) ?? 0) + 1
          spawns.set(name, spawn)
          return { spawn }
        }),
      }))
    for (now = 0; now < 60_000; now += 5_000) {
      for (const name of procedures) {
        const [left, right] = await Promise.all([procedure(name, 'left'), procedure(name, 'right')])
        expect(left.data).toEqual(right.data)
      }
      await settle()
    }

    expect(Object.fromEntries(spawns)).toEqual(
      Object.fromEntries(procedures.map((name) => [name, 2])),
    )
  })

  test('no procedure call reaches orchestrator inside a TTL window', async () => {
    let now = 10_000
    let spawns = 0
    const cache = new TtlCache(30_000, () => now)
    const first = await cache.get('routing:24', () => ++spawns)
    now = 39_999
    expect(await cache.get('routing:24', () => ++spawns)).toBe(first)
    expect(spawns).toBe(1)
  })

  test('an expired value answers at once while one background load replaces it', async () => {
    let now = 0
    let spawns = 0
    let release = () => {}
    const cache = new TtlCache(30_000, () => now)
    const load = () =>
      ++spawns === 1 ? 1 : new Promise<number>((resolve) => (release = () => resolve(spawns)))
    expect(await cache.get('runs', load)).toBe(1)

    now = 30_000
    // The refresh has not finished, yet both callers are answered with the last value.
    expect(await cache.get('runs', load)).toBe(1)
    expect(await cache.get('runs', load)).toBe(1)
    expect(spawns).toBe(2)

    release()
    await settle()
    expect(await cache.get('runs', load)).toBe(2)
    expect(spawns).toBe(2)
  })

  test('a key with no value waits for its load, and callers share it', async () => {
    let spawns = 0
    const cache = new TtlCache(30_000, () => 0)
    const load = async () => ++spawns
    const [left, right] = await Promise.all([cache.get('runs', load), cache.get('runs', load)])
    expect([left, right, spawns]).toEqual([1, 1, 1])
  })

  test('a failed refresh drops the value, so the next call waits and sees the failure', async () => {
    let now = 0
    const cache = new TtlCache(30_000, () => now)
    expect(await cache.get('runs', () => 1)).toBe(1)

    now = 30_000
    const failing = (): Promise<number> => Promise.reject(new Error('orchestrator unreachable'))
    expect(await cache.get('runs', failing)).toBe(1)
    await settle()
    await expect(cache.get('runs', failing)).rejects.toThrow('orchestrator unreachable')
  })

  test('a load that started before a clear never replaces what was loaded after it', async () => {
    const cache = new TtlCache(30_000, () => 0)
    let releaseOld = () => {}
    const old = cache.get(
      'runs',
      () => new Promise<string>((resolve) => (releaseOld = () => resolve('before write'))),
    )
    cache.clear()
    expect(await cache.get('runs', async () => 'after write')).toBe('after write')
    releaseOld()
    await old
    expect(await cache.get('runs', async () => 'reloaded')).toBe('after write')
  })
})
