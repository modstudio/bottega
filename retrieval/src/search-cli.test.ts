import { expect, test } from 'bun:test'
import { formatRefreshSummary } from './search-cli.ts'

test('retrieval search human output reports stale refresh work', () => {
  expect(formatRefreshSummary({ embedded: 2, deleted: 1, unchanged: 3, stale: 4 })).toBe(
    'refresh: 2 embedded, 1 deleted, 3 unchanged, 4 stale',
  )
})
