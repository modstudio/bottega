/**
 * The collect lease, on a database of its own.
 *
 * A separate file so the preloaded migrated store and the process-wide lease
 * handle are isolated from the larger behavioral fixture.
 */
import { beforeAll, expect, test, describe } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
const { acquireLease, releaseLease, leaseHolder, withLease } = await import('./collect.ts')

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
})
