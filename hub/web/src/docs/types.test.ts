import { expect, test } from 'bun:test'
import { docsSource } from './types.ts'

test('the adapter source follows install and sign-in', () => {
  expect(docsSource(false, true)).toBe('local')
  expect(docsSource(true, true)).toBe('hosted')
  expect(docsSource(true, false)).toBe('public')
})
