import { expect, test } from 'bun:test'
import { staleContextHolders } from './context-stale.ts'

test('lists a holder worked after next-action and omits one revised afterward', () => {
  expect(
    staleContextHolders(
      [
        { holder: 'DEV-1', at: '2026-11-08T12:00:00Z' },
        { holder: 'DEV-1', at: '2026-11-08T14:00:00Z' },
        { holder: 'DEV-2', at: '2026-11-08T12:00:00Z' },
      ],
      [
        { holder: 'DEV-1', at: '2026-11-08T11:00:00Z' },
        { holder: 'DEV-2', at: '2026-11-08T13:00:00Z' },
      ],
    ),
  ).toEqual([
    { holder: 'DEV-1', workedAt: '2026-11-08T14:00:00Z', revisedAt: '2026-11-08T11:00:00Z' },
  ])
})

test('omits closed tasks while retaining open and unknown holders without next-actions', () => {
  const work = [
    { holder: 'DEV-DONE', at: '2026-11-08T12:00:00Z' },
    { holder: 'DEV-OPEN', at: '2026-11-08T12:00:00Z' },
    { holder: 'UNKNOWN-1', at: '2026-11-08T12:00:00Z' },
  ]

  expect(
    staleContextHolders(
      work,
      [],
      [
        { holder: 'DEV-DONE', statusCategory: 'done' },
        { holder: 'DEV-OPEN', statusCategory: 'active' },
      ],
    ),
  ).toEqual([
    { holder: 'DEV-OPEN', workedAt: '2026-11-08T12:00:00Z', revisedAt: null },
    { holder: 'UNKNOWN-1', workedAt: '2026-11-08T12:00:00Z', revisedAt: null },
  ])
})
