import { describe, expect, test } from 'bun:test'
import { TtlCache } from './serve.ts'

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

  test('no procedure call reaches orch inside a TTL window', async () => {
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
    const failing = (): Promise<number> => Promise.reject(new Error('orch unreachable'))
    expect(await cache.get('runs', failing)).toBe(1)
    await settle()
    await expect(cache.get('runs', failing)).rejects.toThrow('orch unreachable')
  })
})
