import { beforeAll, expect, spyOn, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import {
  acquireStoredLease,
  holdStoredLease,
  releaseStoredLease,
  storedLeaseSnapshot,
} from './store-lease.ts'

beforeAll(resetFixtureStore)

test('renewing a stored lease keeps its first acquisition time', () => {
  const key = 'test.renewed-lease'
  const holder = 'renewing-holder'
  try {
    expect(acquireStoredLease(key, holder, 60_000, true)).toBeTrue()
    const first = storedLeaseSnapshot(key)
    expect(first).toMatchObject({ since: expect.any(Number) })
    if (!first || 'unreadable' in first) throw new Error('expected a readable lease')

    expect(acquireStoredLease(key, holder, 120_000, true)).toBeTrue()
    expect(storedLeaseSnapshot(key)).toMatchObject({ since: first.since })
  } finally {
    releaseStoredLease(key, holder)
  }
})

test('an unreadable stored lease is distinct from a free lease', () => {
  const key = 'test.unreadable-lease'
  writeTransaction((conn) =>
    conn.query('INSERT INTO setting (key, value) VALUES (?, ?)').run(key, '{not-json'),
  )

  expect(storedLeaseSnapshot(key)).toEqual({ unreadable: true, key })
})

test('a thrown renewal is reported and a later renewal still runs', async () => {
  const key = 'test.throwing-renewal'
  const holder = 'throwing-renewal-holder'
  expect(acquireStoredLease(key, holder, 60_000)).toBeTrue()
  const callbacks: Array<() => void> = []
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    callbacks.push(callback)
    return callbacks.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  const lockError = new Error('database is locked')
  const errors: Error[] = []
  let renewals = 0
  let finish!: () => void
  const canFinish = new Promise<void>((resolve) => (finish = resolve))
  try {
    const held = holdStoredLease({
      key,
      holder,
      durationMs: 60_000,
      renewEveryMs: 1,
      onError: (error) => errors.push(error),
      renewLease: () => {
        renewals++
        if (renewals === 1) throw lockError
        return true
      },
      lostMessage: () => 'lease lost',
      work: async () => canFinish,
    })
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]!).not.toThrow()
    expect(callbacks[0]!).not.toThrow()
    expect(errors).toEqual([lockError])
    expect(renewals).toBe(2)
    finish()
    expect((await held).ran).toBeTrue()
  } finally {
    finish()
    interval.mockRestore()
    releaseStoredLease(key, holder)
  }
})

test('a thrown release is reported without rejecting held work', async () => {
  const key = 'test.throwing-release'
  const holder = 'throwing-release-holder'
  expect(acquireStoredLease(key, holder, 60_000)).toBeTrue()
  const releaseError = new Error('database is locked during release')
  const errors: Error[] = []
  try {
    const result = await holdStoredLease({
      key,
      holder,
      durationMs: 60_000,
      renewEveryMs: 60_000,
      onError: (error) => errors.push(error),
      releaseLease: () => {
        throw releaseError
      },
      lostMessage: () => 'lease lost',
      work: async () => 'finished',
    })

    expect(result).toEqual({ ran: true, value: 'finished' })
    expect(errors).toEqual([releaseError])
  } finally {
    releaseStoredLease(key, holder)
  }
})
