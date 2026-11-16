import { expect, test } from 'bun:test'
import { reviewFunnelVerdictForChange } from './review-funnel-verdict-service.ts'

test('an empty change returns before gathering funnel facts', () => {
  const commit = '0123456789abcdef'
  expect(
    reviewFunnelVerdictForChange({
      head: commit,
      base: commit,
      database: new Proxy(
        {},
        {
          get() {
            throw new Error('database must not be read for an empty change')
          },
        },
      ) as never,
      cwd: '/path/that/must/not/be/read',
      branch: 'DEV-2350-empty',
      project: new Proxy(
        {},
        {
          get() {
            throw new Error('project must not be read for an empty change')
          },
        },
      ) as never,
    }),
  ).toEqual({ kind: 'empty', commit, base: commit })
})
