import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { formatRefreshSummary, parseSearchArguments } from './search-cli.ts'

test('retrieval search human output reports stale refresh work', () => {
  expect(formatRefreshSummary({ embedded: 2, deleted: 1, unchanged: 3, stale: 4 })).toBe(
    'refresh: 2 embedded, 1 deleted, 3 unchanged, 4 stale',
  )
})

test('retrieval search accepts options before the query', () => {
  expect(
    parseSearchArguments(['--code', '--project', '/checkout', '--k', '3', '--json', 'meaning']),
  ).toEqual({
    query: 'meaning',
    k: 3,
    json: true,
    code: true,
    projectPath: '/checkout',
    includeDrafts: false,
  })
})

test('retrieval document search parses address filters', () => {
  expect(
    parseSearchArguments(['--scope', 'canon', '--subject', PLATFORM_SLUG, '--k', '3', 'meaning']),
  ).toEqual({
    query: 'meaning',
    k: 3,
    json: false,
    code: false,
    includeDrafts: false,
    scope: 'canon',
    subject: PLATFORM_SLUG,
  })
})

test('retrieval document search parses draft inclusion', () => {
  expect(parseSearchArguments(['meaning', '--include-drafts'])).toMatchObject({
    query: 'meaning',
    includeDrafts: true,
    code: false,
  })
})

test('retrieval search refuses an unknown option', () => {
  expect(() => parseSearchArguments(['meaning', '--invented'])).toThrow('usage:')
})
