import { expect, test } from 'bun:test'
import { parseBuiltCommit } from './built-commit.ts'

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
