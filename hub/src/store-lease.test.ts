import { beforeAll, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { acquireStoredLease, releaseStoredLease, storedLeaseSnapshot } from './store-lease.ts'

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
