import { expect, test } from 'bun:test'
import { savedVersionAuthor, showSourceFiles } from './reading.tsx'

test('source files are shown only to private technical or unfiltered readers', () => {
  const paths = ['hub/views/src/docs/reading.tsx']
  expect(showSourceFiles(true, null, paths)).toBe(true)
  expect(showSourceFiles(true, 'technical', paths)).toBe(true)
  expect(showSourceFiles(true, 'internal', paths)).toBe(false)
  expect(showSourceFiles(true, 'customer', paths)).toBe(false)
  expect(showSourceFiles(false, null, paths)).toBe(false)
  expect(showSourceFiles(true, null, [])).toBe(false)
})

test('saved version authors prefer a supplied name', () => {
  expect(savedVersionAuthor('user-1', '  Ada Lovelace  ')).toBe('Ada Lovelace')
})

test('saved version authors preserve a stored author when no name is supplied', () => {
  expect(savedVersionAuthor('  Editor  ')).toBe('Editor')
})

test('saved version authors use the system fallback for unknown', () => {
  expect(savedVersionAuthor(' unknown ')).toBe('System')
})
