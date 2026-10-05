/**
 * The collect lease, on a database of its own.
 *
 * A separate file so the preloaded migrated store and the process-wide lease
 * handle are isolated from the larger behavioral fixture.
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'

const { COLLECT_LEASE_MS, acquireLease, releaseLease, leaseHolder, watch, withLease } =
  await import('./collect.ts')

beforeAll(resetFixtureStore)

describe('collect lease', () => {
  test('only one holder at a time', () => {
    expect(acquireLease('a')).toBe(true)
    expect(acquireLease('b')).toBe(false)
    expect(leaseHolder()).toBe('a')
    releaseLease('a')
    expect(acquireLease('b')).toBe(true)
    releaseLease('b')
  })

  test('a one-shot collect waits for the lease instead of racing it', async () => {
    // This is the bug: `hub collect` called collect() directly and never took
    // the lease, so it interleaved with the server's watcher while the
    // transcripts leg was clearing and rewriting a session's spans. Two
    // identical collects beside `hub serve` disagreed by two hours.
    acquireLease('watcher')
    let ran = false
    const r = await withLease(
      'one-shot',
      async () => {
        ran = true
      },
      300,
    )
    expect(r.ran).toBe(false)
    expect(ran).toBe(false)
    if (!r.ran) expect(r.heldBy).toBe('watcher')
    releaseLease('watcher')
  })

  test('and proceeds once the holder hands it back', async () => {
    acquireLease('watcher')
    setTimeout(() => releaseLease('watcher'), 100)
    let ran = false
    const r = await withLease(
      'one-shot',
      async () => {
        ran = true
      },
      5000,
    )
    expect(r.ran).toBe(true)
    expect(ran).toBe(true)
    // Handed back on the way out, so the next collector is not made to wait.
    expect(leaseHolder()).toBeNull()
  })

  test('the lease is released even when the collect throws', async () => {
    await expect(
      withLease(
        'boom',
        async () => {
          throw new Error('leg failed')
        },
        500,
      ),
    ).rejects.toThrow('leg failed')
    expect(leaseHolder()).toBeNull()
  })

  test('a watch cycle releases the lease before stop', async () => {
    let cycleFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      cycleFinished = resolve
    })
    const stop = watch('watcher', undefined, {
      initial: async () => {
        cycleFinished()
      },
      fast: async () => {},
      slow: async () => {},
    })
    await finished
    await Bun.sleep(0)

    let explicitRan = false
    const result = await withLease(
      'explicit',
      async () => {
        explicitRan = true
      },
      0,
    )
    expect(result.ran).toBeTrue()
    expect(explicitRan).toBeTrue()
    await stop()
  })

  test('a long one-shot renews until its callback finishes', async () => {
    let now = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    let finish!: () => void
    const canFinish = new Promise<void>((resolve) => (finish = resolve))
    let started!: () => void
    const didStart = new Promise<void>((resolve) => (started = resolve))
    try {
      const running = withLease(
        'long-one-shot',
        async () => {
          started()
          await canFinish
        },
        0,
        5,
      )
      await didStart
      now += COLLECT_LEASE_MS + 1
      await Bun.sleep(10)
      expect(acquireLease('competitor')).toBeFalse()
      finish()
      expect((await running).ran).toBeTrue()
      expect(acquireLease('competitor')).toBeTrue()
      releaseLease('competitor')
    } finally {
      clock.mockRestore()
    }
  })

  test('a long watch cycle renews until its work finishes', async () => {
    let now = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    let finish!: () => void
    const canFinish = new Promise<void>((resolve) => (finish = resolve))
    let started!: () => void
    const didStart = new Promise<void>((resolve) => (started = resolve))
    const stop = watch('long-watch', undefined, {
      initial: async () => {
        started()
        await canFinish
      },
      fast: async () => {},
      slow: async () => {},
      renewEveryMs: 5,
    })
    try {
      await didStart
      now += COLLECT_LEASE_MS + 1
      await Bun.sleep(10)
      expect(acquireLease('competitor')).toBeFalse()
      finish()
      await stop()
      expect(acquireLease('competitor')).toBeTrue()
      releaseLease('competitor')
    } finally {
      clock.mockRestore()
    }
  })
})
