import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  COLLECT_LEASE_HELD_WARN_MS,
  collectLeaseHeldCondition,
  observeCollectLease,
} from './monitor-collect-lease.ts'

describe('collect lease held condition', () => {
  const now = 1_000_000

  test('distinguishes free, short, long, and unknown-age leases', () => {
    expect(collectLeaseHeldCondition(null, null, now)).toBeNull()
    expect(
      collectLeaseHeldCondition('collect:short', now - COLLECT_LEASE_HELD_WARN_MS, now),
    ).toBeNull()
    expect(
      collectLeaseHeldCondition('collect:long', now - COLLECT_LEASE_HELD_WARN_MS - 1, now),
    ).toMatchObject({
      kind: 'collect-lease-held',
      subject: 'collect:long',
      ageMs: COLLECT_LEASE_HELD_WARN_MS + 1,
      action: expect.stringContaining(`${PLATFORM_SLUG} record lease`),
    })
    expect(collectLeaseHeldCondition('collect:legacy', null, now)).toBeNull()
  })
})

test('a spawn failure makes the collect lease observation unavailable', () => {
  const observation = observeCollectLease(1_000_000, (() => {
    throw new Error('ENOENT: missing entry')
  }) as typeof Bun.spawnSync)

  expect(observation).toEqual({
    conditions: [],
    errors: ['collect lease observation unavailable: ENOENT: missing entry'],
  })
})
