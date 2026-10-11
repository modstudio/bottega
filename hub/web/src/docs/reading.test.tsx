import { expect, test } from 'bun:test'
import { showSourceFiles } from './reading.tsx'

test('source files are shown only to private technical or unfiltered readers', () => {
  const paths = ['hub/web/src/docs/reading.tsx']
  expect(showSourceFiles(true, null, paths)).toBe(true)
  expect(showSourceFiles(true, 'technical', paths)).toBe(true)
  expect(showSourceFiles(true, 'internal', paths)).toBe(false)
  expect(showSourceFiles(true, 'customer', paths)).toBe(false)
  expect(showSourceFiles(false, null, paths)).toBe(false)
  expect(showSourceFiles(true, null, [])).toBe(false)
})
