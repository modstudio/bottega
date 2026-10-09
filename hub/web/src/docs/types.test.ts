import { expect, test } from 'bun:test'
import { docsSource, docsSourceLabel } from './types.ts'

test('the adapter source follows install and sign-in', () => {
  expect(docsSource(false, true)).toBe('local')
  expect(docsSource(true, true)).toBe('hosted')
  expect(docsSource(true, false)).toBe('public')
})

test('the source label follows the adapter and names an available hosted space', () => {
  expect(docsSourceLabel('local')).toBe('Local store')
  expect(docsSourceLabel('hosted')).toBe('Hosted record')
  expect(docsSourceLabel('hosted', 'Workshop')).toBe('Hosted record · Workshop')
  expect(docsSourceLabel('public')).toBe('Public')
})
