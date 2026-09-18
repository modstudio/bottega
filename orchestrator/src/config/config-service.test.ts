import { expect, test } from 'bun:test'
import { planRotation } from './config-service.ts'

test('rotation plan re-seals only rows on older DEKs and retires each old DEK once', () => {
  const row = (key: string, dekId: string) => ({
    key,
    dekId,
    environment: 'default',
    scope: 'space' as const,
    rowVersion: 1,
    updatedAt: '2026-09-18T12:00:00.000Z',
  })
  const current = '01990000-0000-7000-8000-000000000003'
  expect(
    planRotation(
      [row('a', 'old-b'), row('b', current), row('c', 'old-a'), row('d', 'old-b')],
      current,
    ),
  ).toEqual({
    reseal: [row('a', 'old-b'), row('c', 'old-a'), row('d', 'old-b')],
    retireDekIds: ['old-a', 'old-b'],
  })
})
