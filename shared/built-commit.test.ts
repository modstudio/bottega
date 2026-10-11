import { expect, test } from 'bun:test'
import { builtCommitResponse, parseBuiltCommit } from './built-commit.ts'

test('parses only a full hexadecimal commit', () => {
  const lowercase = '0123456789abcdef0123456789abcdef01234567'
  expect(parseBuiltCommit(`  ${lowercase}  `)).toBe(lowercase)
  expect(parseBuiltCommit('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe(
    'abcdef0123456789abcdef0123456789abcdef01',
  )
  expect(parseBuiltCommit('0123456')).toBeUndefined()
  expect(parseBuiltCommit('g123456789abcdef0123456789abcdef01234567')).toBeUndefined()
  expect(parseBuiltCommit(undefined)).toBeUndefined()
})

test('answers with the built commit', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  expect(builtCommitResponse(commit)).toEqual({ status: 200, body: { commit } })
})

test('answers that an absent built commit is unknown', () => {
  expect(builtCommitResponse(undefined)).toEqual({
    status: 503,
    body: { commit: null, error: 'the commit this app was built from is unknown' },
  })
})
