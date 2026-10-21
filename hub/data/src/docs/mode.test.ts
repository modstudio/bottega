import { expect, test } from 'bun:test'
import { docsSource, docsSourceLabel, revisionIdForSource } from './mode.ts'

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

test('revision ids follow the selected document source', () => {
  const hostedId = '01990000-0000-7000-8000-000000000001'
  expect(revisionIdForSource('local', '8')).toBe(8)
  expect(revisionIdForSource('local', hostedId)).toBeNull()
  expect(revisionIdForSource('hosted', hostedId)).toBe(hostedId)
  expect(revisionIdForSource('hosted', '8')).toBeNull()
  expect(revisionIdForSource('public', hostedId)).toBeNull()
})
