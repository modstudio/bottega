import { expect, test } from 'bun:test'
import { formatRefreshSummary, parseSearchArguments } from './search-cli.ts'

test('retrieval search human output reports stale refresh work', () => {
  expect(formatRefreshSummary({ embedded: 2, deleted: 1, unchanged: 3, stale: 4 })).toBe(
    'refresh: 2 embedded, 1 deleted, 3 unchanged, 4 stale',
  )
})

test('retrieval search accepts options before the query', () => {
  expect(
    parseSearchArguments(['--code', '--project', '/checkout', '--k', '3', '--json', 'meaning']),
  ).toEqual({ query: 'meaning', k: 3, json: true, code: true, projectPath: '/checkout' })
})
