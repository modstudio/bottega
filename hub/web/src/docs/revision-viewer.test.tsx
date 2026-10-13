import { expect, test } from 'bun:test'
import { revisionIdForSource, revisionViewError } from './revision-viewer.tsx'

test('revision ids follow the selected document source', () => {
  const hostedId = '01990000-0000-7000-8000-000000000001'
  expect(revisionIdForSource('local', '8')).toBe(8)
  expect(revisionIdForSource('local', hostedId)).toBeNull()
  expect(revisionIdForSource('hosted', hostedId)).toBe(hostedId)
  expect(revisionIdForSource('hosted', '8')).toBeNull()
  expect(revisionIdForSource('public', hostedId)).toBeNull()
})

test('revision errors distinguish pending reads from invalid, absent, and failed reads', () => {
  expect(
    revisionViewError({ param: 'old', id: null, historyIds: undefined, readFailed: false }),
  ).toBe('Revision old could not be read.')
  expect(revisionViewError({ param: '8', id: 8, historyIds: [7], readFailed: false })).toBe(
    'Revision 8 could not be read.',
  )
  expect(revisionViewError({ param: '8', id: 8, historyIds: [8], readFailed: true })).toBe(
    'Revision 8 could not be read.',
  )
  expect(
    revisionViewError({ param: '8', id: 8, historyIds: undefined, readFailed: false }),
  ).toBeNull()
})
