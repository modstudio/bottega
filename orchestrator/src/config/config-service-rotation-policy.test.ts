import { expect, test } from 'bun:test'
import { planRotation, shouldRotateAfterRevocation } from './config-service.ts'

const row = (key: string, dekId: string) => ({
  key,
  dekId,
  environment: 'default',
  scope: 'space' as const,
  rowVersion: 1,
  updatedAt: '2026-09-18T12:00:00.000Z',
})
const key = (id: string, version: number, retiredAt: string | null = null) => ({
  id,
  version,
  retiredAt,
  createdAt: '2026-09-18T12:00:00.000Z',
  wraps: [],
})

test('rotation plan re-seals only rows on older DEKs and retires each old DEK once', () => {
  const current = '01990000-0000-7000-8000-000000000003'
  expect(
    planRotation(
      [row('a', 'old-b'), row('b', current), row('c', 'old-a'), row('d', 'old-b')],
      key(current, 3),
      [key('old-a', 1), key('old-b', 2), key(current, 3)],
    ),
  ).toEqual({
    reseal: [row('a', 'old-b'), row('c', 'old-a'), row('d', 'old-b')],
    retireDekIds: ['old-a', 'old-b'],
  })
})

test('revocation rotation policy compares only revocation and data-key timestamps', () => {
  const current = key('dek', 1)
  current.createdAt = '2026-06-01T00:00:00.000Z'
  expect(shouldRotateAfterRevocation(current, [])).toBe(false)
  expect(shouldRotateAfterRevocation(current, [{ revokedAt: null }])).toBe(false)
  expect(shouldRotateAfterRevocation(current, [{ revokedAt: current.createdAt }])).toBe(false)
  expect(shouldRotateAfterRevocation(current, [{ revokedAt: '2026-05-31T23:59:59.999Z' }])).toBe(
    false,
  )
  expect(shouldRotateAfterRevocation(current, [{ revokedAt: '2026-06-01T00:00:00.001Z' }])).toBe(
    true,
  )
})
