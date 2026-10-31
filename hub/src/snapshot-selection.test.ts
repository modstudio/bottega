import { expect, test } from 'bun:test'
import { selectSnapshot } from './snapshot-selection.ts'

test('snapshot selection defaults to newest and never merges machines', () => {
  const older = {
    machineId: 'older',
    machine: { id: 'older', shortName: null, displayName: null },
    takenAt: '2026-09-16T12:00:00.000Z',
    payload: ['old'],
  }
  const newer = {
    machineId: 'newer',
    machine: { id: 'newer', shortName: null, displayName: null },
    takenAt: '2026-09-17T12:00:00.000Z',
    payload: ['new'],
  }
  expect(selectSnapshot([older, newer])?.selected).toEqual(newer)
  expect(selectSnapshot([older, newer], 'older')?.selected).toEqual(older)
})
