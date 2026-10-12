import { expect, test } from 'bun:test'
import { revisionViewError } from './revision-viewer.tsx'

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
