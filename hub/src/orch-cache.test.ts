import { describe, expect, test } from 'bun:test'
import { TtlCache } from './serve.ts'

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
        const [left, right] = await Promise.all([
          procedure(name, 'left'),
          procedure(name, 'right'),
        ])
        expect(left.data).toEqual(right.data)
        expect(left.data.spawn).toBe(now < 30_000 ? 1 : 2)
      }
    }

    expect(Object.fromEntries(spawns)).toEqual(Object.fromEntries(
      procedures.map((name) => [name, 2]),
    ))
  })

  test('no procedure call reaches orch inside a TTL window', async () => {
    let now = 10_000
    let spawns = 0
    const cache = new TtlCache(30_000, () => now)
    const first = await cache.get('routing:24', () => ++spawns)
    now = 39_999
    const inside = await cache.get('routing:24', () => ++spawns)
    expect(inside).toBe(first)
    expect(spawns).toBe(1)
    now = 40_000
    expect(await cache.get('routing:24', () => ++spawns)).toBe(2)
  })
})
