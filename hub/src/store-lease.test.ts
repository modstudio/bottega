import { beforeAll, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { acquireStoredLease, releaseStoredLease, storedLeaseSnapshot } from './store-lease.ts'

beforeAll(resetFixtureStore)

test('renewing a stored lease keeps its first acquisition time', () => {
  const key = 'test.renewed-lease'
  const holder = 'renewing-holder'
  try {
    expect(acquireStoredLease(key, holder, 60_000, true)).toBeTrue()
    const first = storedLeaseSnapshot(key)
    expect(first?.since).toBeNumber()

    expect(acquireStoredLease(key, holder, 120_000, true)).toBeTrue()
    expect(storedLeaseSnapshot(key)?.since).toBe(first?.since)
  } finally {
    releaseStoredLease(key, holder)
  }
})
