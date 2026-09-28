import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { ingestRunFixtures, resetFixtureStore, runFixture } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import { LocalHubAuth } from './local-auth.ts'
import { stopDashboardCapability } from './orch.ts'
import { clearOrchCache, handleTrpcRequest, trpcMutationRequestAllowed, view } from './serve.ts'

test('tRPC mutation requests require browser same-origin proof', () => {
  const request = (headers?: HeadersInit, method = 'POST') =>
    new Request('http://127.0.0.1:4567/trpc/run.score', { method, headers })
  expect(trpcMutationRequestAllowed(request({ Origin: 'http://127.0.0.1:4567' }))).toBe(true)
  expect(trpcMutationRequestAllowed(request({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(true)
  expect(trpcMutationRequestAllowed(request({ Origin: 'https://attacker.example' }))).toBe(false)
  expect(trpcMutationRequestAllowed(request({ 'Content-Type': 'text/plain' }))).toBe(false)
  expect(trpcMutationRequestAllowed(request(undefined, 'GET'))).toBe(true)
})

test('a forged same-origin context mutation without a login cookie never reaches orch', async () => {
  stopDashboardCapability()
  const spawn = spyOn(Bun, 'spawn')
  try {
    const origin = 'http://127.0.0.1:4567'
    const response = await handleTrpcRequest(
      new Request(`${origin}/trpc/context.autonomy.set`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ json: { project: 'alpha', stage: 'review', value: 'auto' } }),
      }),
    )
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('hub login')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
  }
})

test('a valid login session admits a same-origin mutation to the router', async () => {
  stopDashboardCapability()
  const spawn = spyOn(Bun, 'spawn')
  const state = mkdtempSync(join(tmpdir(), 'hub-serve-auth-'))
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  const auth = new LocalHubAuth({ [STATE_HOME_ENV]: state }, Date.now, () => ids.shift()!)
  try {
    const origin = 'http://127.0.0.1:4567'
    const login = auth.mintLoginUrl(4567)
    const exchange = auth.exchange(new Request(login))
    const cookie = exchange.headers.get('set-cookie')!
    const response = await handleTrpcRequest(
      new Request(`${origin}/trpc/context.autonomy.set`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          'Content-Type': 'application/json',
          cookie,
        },
        body: JSON.stringify({ json: { project: 'alpha', stage: 'review', value: 'auto' } }),
      }),
      auth,
    )
    expect(response.status).not.toBe(401)
    expect(await response.text()).toContain('Dashboard mutation capability is unavailable')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
    rmSync(state, { recursive: true, force: true })
  }
})

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
      .query(`SELECT task_key, via FROM interval WHERE ref = 'orch:9801'`)
      .get() as { task_key: string; via: string }
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
      stdout: new Blob([argv.includes('runs') ? JSON.stringify(run) : JSON.stringify(state)]),
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
      evidence_excluded: 'voided with orch score --void',
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
      stdout: new Blob([argv.includes('runs') ? JSON.stringify(run) : JSON.stringify(state)]),
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
          evidence_excluded: 'voided with orch score --void',
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
        argv.includes('runs')
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
        argv.includes('runs')
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
        argv.includes('runs')
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
