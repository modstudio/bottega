import { expect, test } from 'bun:test'
import { CONTEXT_STALE_WORK_WINDOW_MS, staleContextHolders } from './context-stale.ts'

test('uses a twenty-four hour work window', () => {
  expect(CONTEXT_STALE_WORK_WINDOW_MS).toBe(24 * 60 * 60 * 1_000)
})

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
      '2026-11-09T10:00:00Z',
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
    staleContextHolders(work, [], '2026-11-09T10:00:00Z', [
      { holder: 'DEV-DONE', statusCategory: 'done' },
      { holder: 'DEV-OPEN', statusCategory: 'active' },
    ]),
  ).toEqual([
    { holder: 'DEV-OPEN', workedAt: '2026-11-08T12:00:00Z', revisedAt: null },
    { holder: 'UNKNOWN-1', workedAt: '2026-11-08T12:00:00Z', revisedAt: null },
  ])
})

test('ignores old work and judges mixed and unrevised holders from recent work', () => {
  expect(
    staleContextHolders(
      [
        { holder: 'DEV-OLD', at: '2026-11-08T09:59:59Z' },
        { holder: 'DEV-MIXED', at: '2026-11-08T09:00:00Z' },
        { holder: 'DEV-MIXED', at: '2026-11-09T09:00:00Z' },
        { holder: 'DEV-MISSING', at: '2026-11-09T08:00:00Z' },
      ],
      [{ holder: 'DEV-MIXED', at: '2026-11-08T12:00:00Z' }],
      '2026-11-09T10:00:00Z',
    ),
  ).toEqual([
    {
      holder: 'DEV-MISSING',
      workedAt: '2026-11-09T08:00:00Z',
      revisedAt: null,
    },
    {
      holder: 'DEV-MIXED',
      workedAt: '2026-11-09T09:00:00Z',
      revisedAt: '2026-11-08T12:00:00Z',
    },
  ])
})
