/**
 * The collect lease, on a database of its own.
 *
 * A separate file so the preloaded migrated store and the process-wide lease
 * handle are isolated from the larger behavioral fixture.
 */
import { beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db } from './db.ts'
import type { HostedOutboxReport } from './outbox.ts'
import { acquireStoredLeaseIntent, releaseStoredLease } from './store-lease.ts'
import { hostedCreateTask } from './task-client.ts'

const {
  COLLECT_LEASE_MS,
  acquireLease,
  collectFastHostedOutbox,
  explicitRequestMayAcquire,
  releaseLease,
  leaseHolder,
  watch,
  watcherMayStartCycle,
  withLease,
} = await import('./collect.ts')

beforeAll(resetFixtureStore)

const waitingOutboxReport = (): HostedOutboxReport => ({
  queued: 1,
  sent: 0,
  rejected: 0,
  quarantined: 0,
  dropped: 0,
  waitingOnRouting: { unregistered: 1 },
  skippedCapability: false,
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await Bun.sleep(1)
  expect(check()).toBeTrue()
}

function intentHolder(): string | null {
  const row = db()
    .query<{ value: string }, []>(`SELECT value FROM setting WHERE key='collect.lease.intent'`)
    .get()
  return row ? (JSON.parse(row.value) as { holder: string }).holder : null
}

describe('watch cycle start decision', () => {
  const facts = {
    leaseHolder: null,
    intentHolder: null,
    intentUntil: null,
    now: 1_000,
  }

  test('starts without a waiter intent', () => {
    expect(watcherMayStartCycle('watcher', facts)).toBeTrue()
  })

  test("does not start for another holder's live intent", () => {
    expect(
      watcherMayStartCycle('watcher', {
        ...facts,
        intentHolder: 'explicit',
        intentUntil: 1_001,
      }),
    ).toBeFalse()
  })

  test('starts when another holder intent has expired', () => {
    expect(
      watcherMayStartCycle('watcher', {
        ...facts,
        intentHolder: 'explicit',
        intentUntil: 1_000,
      }),
    ).toBeTrue()
  })

  test('starts for its own live intent', () => {
    expect(
      watcherMayStartCycle('watcher', {
        ...facts,
        intentHolder: 'watcher',
        intentUntil: 1_001,
      }),
    ).toBeTrue()
  })
})

describe('explicit request start decision', () => {
  const facts = {
    leaseHolder: 'watcher',
    intentHolder: null,
    intentUntil: null,
    now: 1_000,
  }

  test('allows requests without a waiter intent', () => {
    expect(explicitRequestMayAcquire('explicit', facts)).toBeTrue()
  })

  test("waits behind another holder's live intent", () => {
    expect(
      explicitRequestMayAcquire('explicit', {
        ...facts,
        intentHolder: 'other-explicit',
        intentUntil: 1_001,
      }),
    ).toBeFalse()
  })

  test('allows its own, expired, or invalid intent', () => {
    expect(
      explicitRequestMayAcquire('explicit', {
        ...facts,
        intentHolder: 'explicit',
        intentUntil: 1_001,
      }),
    ).toBeTrue()
    expect(
      explicitRequestMayAcquire('explicit', {
        ...facts,
        intentHolder: 'other-explicit',
        intentUntil: 1_000,
      }),
    ).toBeTrue()
    expect(
      explicitRequestMayAcquire('explicit', {
        ...facts,
        intentHolder: 'other-explicit',
        intentUntil: null,
      }),
    ).toBeTrue()
  })
})

describe('collect lease', () => {
  test('an expired stored waiter intent lets the watcher acquire', () => {
    const intentKey = 'collect.lease.intent'
    try {
      expect(acquireStoredLeaseIntent(intentKey, 'abandoned-waiter', Date.now() - 1)).toBeTrue()
      expect(acquireLease('watcher-after-abandoned-waiter')).toBeTrue()
      expect(leaseHolder()).toBe('watcher-after-abandoned-waiter')
    } finally {
      releaseLease('watcher-after-abandoned-waiter')
      releaseStoredLease(intentKey, 'abandoned-waiter')
    }
  })

  test('only one holder at a time', () => {
    expect(acquireLease('a')).toBe(true)
    expect(acquireLease('b')).toBe(false)
    expect(leaseHolder()).toBe('a')
    releaseLease('a')
    expect(acquireLease('b')).toBe(true)
    releaseLease('b')
  })

  test('a one-shot collect waits for the lease instead of racing it', async () => {
    // This is the bug: `bottega record pull` called collect() directly and never took
    // the lease, so it interleaved with the server's watcher while the
    // transcripts leg was clearing and rewriting a session's spans. Two
    // identical collects beside `bottega dashboard start` disagreed by two hours.
    acquireLease('watcher')
    let ran = false
    const pending = withLease(
      'one-shot',
      async () => {
        ran = true
      },
      300,
    )
    expect(intentHolder()).toBe('one-shot')
    const r = await pending
    expect(r.ran).toBe(false)
    expect(ran).toBe(false)
    if (!r.ran) expect(r.heldBy).toBe('watcher')
    expect(intentHolder()).toBeNull()
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

  test('a waiting explicit request takes the next turn from watch', async () => {
    const callbacks: Array<() => void> = []
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
    ) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval)
    let finishInitial!: () => void
    const initialCanFinish = new Promise<void>((resolve) => (finishInitial = resolve))
    let initialStarted!: () => void
    const didStartInitial = new Promise<void>((resolve) => (initialStarted = resolve))
    let finishExplicit!: () => void
    const explicitCanFinish = new Promise<void>((resolve) => (finishExplicit = resolve))
    let explicitStarted!: () => void
    const didStartExplicit = new Promise<void>((resolve) => (explicitStarted = resolve))
    let watcherCycles = 0
    const stop = watch('turn-watch', undefined, {
      initial: async () => {
        watcherCycles++
        initialStarted()
        await initialCanFinish
      },
      fast: async () => {
        watcherCycles++
      },
      slow: async () => {},
    })
    try {
      await didStartInitial
      const explicit = withLease(
        'turn-explicit',
        async () => {
          expect(intentHolder()).toBeNull()
          explicitStarted()
          await explicitCanFinish
        },
        1_000,
      )
      expect(intentHolder()).toBe('turn-explicit')

      finishInitial()
      await waitFor(() => leaseHolder() === null)
      callbacks[1]!()
      await Bun.sleep(0)
      expect(watcherCycles).toBe(1)

      await didStartExplicit
      expect(leaseHolder()).toBe('turn-explicit')
      expect(watcherCycles).toBe(1)
      finishExplicit()
      expect((await explicit).ran).toBeTrue()

      callbacks[1]!()
      await waitFor(() => watcherCycles === 2)
    } finally {
      finishInitial()
      finishExplicit()
      await stop()
      interval.mockRestore()
    }
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

  test('a watch cycle that loses its lease stops before the next leg', async () => {
    const legs: string[] = []
    let report!: (error: Error) => void
    const reported = new Promise<Error>((resolve) => (report = resolve))
    const stop = watch('losing-watch', report, {
      initial: async (guard) => {
        legs.push('first')
        releaseLease('losing-watch')
        expect(acquireLease('takeover')).toBeTrue()
        guard.assertHeld('first')
        legs.push('second')
      },
      fast: async () => {},
      slow: async () => {},
    })
    try {
      const error = await reported
      expect(error.message).toContain('takeover holds the collect lease')
      expect(error.message).toContain('stopped after first')
      expect(legs).toEqual(['first'])
    } finally {
      releaseLease('takeover')
      await stop()
    }
  })

  test('watch shares hosted outbox state between its slow and fast cycles', async () => {
    const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
    process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
    const callbacks: Array<() => void> = []
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
    ) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval)
    let initialized!: () => void
    const ready = new Promise<void>((resolve) => (initialized = resolve))
    let drains = 0
    let now = '2026-10-12T12:00:02.000Z'
    let newestQueuedAt = '2026-10-12T12:00:01.000Z'
    const stop = watch('shared-outbox-watch', undefined, {
      initial: async () => initialized(),
      outbox: async () => {
        drains++
        return waitingOutboxReport()
      },
      outboxClock: () => now,
      slow: async (_guard, schedule) => schedule!.slow(),
      fast: async (_guard, schedule) => {
        await schedule!.fast({ pendingCount: 1, newestQueuedAt })
      },
    })
    try {
      await ready
      await Bun.sleep(0)
      const fastCycle = callbacks[1]!
      const slowCycle = callbacks[2]!
      slowCycle()
      await waitFor(() => drains === 1)
      await waitFor(() => leaseHolder() === null)
      fastCycle()
      await waitFor(() => leaseHolder() === null)
      expect(drains).toBe(1)

      newestQueuedAt = '2026-10-12T12:00:02.000Z'
      now = '2026-10-12T12:00:03.000Z'
      fastCycle()
      await waitFor(() => drains === 2)
      await waitFor(() => leaseHolder() === null)
      fastCycle()
      await waitFor(() => leaseHolder() === null)
      expect(drains).toBe(2)
    } finally {
      await stop()
      interval.mockRestore()
      if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
      else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
    }
  })

  test('a timed-out hosted drain releases watch for the next local cycle', async () => {
    const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
    process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
    const callbacks: Array<() => void> = []
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
    ) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval)
    let initialized!: () => void
    const ready = new Promise<void>((resolve) => (initialized = resolve))
    let localCycles = 0
    let completedCycles = 0
    const errors: Error[] = []
    const stop = watch('deadline-outbox-watch', (error) => errors.push(error), {
      initial: async () => initialized(),
      outbox: async () => {
        await hostedCreateTask(
          {},
          {
            baseUrl: 'https://hub.example.test',
            token: 'test',
            fetch: async () => await new Promise<Response>(() => {}),
            requestDeadlineMs: 5,
          },
        )
        return waitingOutboxReport()
      },
      outboxClock: () => '2026-10-12T12:00:02.000Z',
      fast: async (guard, schedule) => {
        localCycles++
        await collectFastHostedOutbox(
          schedule!,
          {
            pending: () => ({
              pendingCount: 1,
              newestQueuedAt: '2026-10-12T12:00:01.000Z',
            }),
          },
          guard,
        )
        completedCycles++
      },
      slow: async () => {},
    })
    try {
      await ready
      await Bun.sleep(0)
      const fastCycle = callbacks[1]!
      fastCycle()
      await waitFor(() => completedCycles === 1)
      await waitFor(() => leaseHolder() === null)
      fastCycle()
      await waitFor(() => completedCycles === 2)
      await waitFor(() => leaseHolder() === null)
      expect(localCycles).toBe(2)
      expect(errors).toEqual([])
    } finally {
      await stop()
      interval.mockRestore()
      if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
      else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
    }
  })
})
