import { expect, test } from 'bun:test'
import { formatSessionLosses } from './session-losses-format.ts'

const report = (brief: { bytes: number; lines: number; overCap: boolean } | null) =>
  ({
    sessionId: 'session-a',
    firstRowAt: '2026-11-13T11:00:00.000Z',
    lastRowAt: '2026-11-13T13:00:00.000Z',
    wallHours: 2,
    tokens: { input: 2, cacheRead: 4, cacheCreation: 6, output: 8, total: 20 },
    tokensPerSessionHour: { input: 1, cacheRead: 2, cacheCreation: 3, output: 4, total: 10 },
    costPerSessionHour: 'subscription, unpriced',
    boundaries: [
      {
        at: '2026-11-13T12:00:00.000Z',
        trigger: 'auto',
        preTokens: 100,
        postTokens: 20,
        brief,
        before: { turns: 1, mean: 10, p90: 10 },
        after: { turns: 1, mean: 10, p90: 10 },
        lost: {
          runs: { count: 0, ids: [] },
          cursors: { count: 0, ids: [] },
          claims: { count: 0, ids: [] },
        },
        candidateFile: '/tmp/candidates.json',
        candidateCount: 0,
        judge: null,
      },
    ],
  }) as Parameters<typeof formatSessionLosses>[0][number]

test('session losses renders measured and missing brief columns', () => {
  expect(formatSessionLosses([report({ bytes: 10_120, lines: 80, overCap: true })])).toContain(
    'brief=10,120 bytes/80 lines OVER CAP',
  )
  expect(formatSessionLosses([report(null)])).toContain('brief=\n')
})
