import { expect, test } from 'bun:test'
import { type ReaderTreeObservation, readerTreeHealthConditions } from './reader-tree-conditions.ts'

const reader: ReaderTreeObservation = {
  runId: '40000000-0000-4000-8000-000000000000',
  runNumber: 1,
  project: 'alpha',
  worktree: '/alpha/tree-a',
  commit: 'abc123',
  startedAt: '2026-10-30T10:00:00.000Z',
  live: true,
  confined: true,
  readOnly: true,
  dirty: false,
  dirtyDetail: 'clean',
}

test('reader tree health reports dirty sharing and duplicate confined clones', () => {
  const conditions = readerTreeHealthConditions([
    reader,
    {
      ...reader,
      runId: '41000000-0000-4000-8000-000000000000',
      runNumber: 2,
      dirty: true,
      dirtyDetail: 'tracked path changed',
    },
    {
      ...reader,
      runId: '42000000-0000-4000-8000-000000000000',
      runNumber: 3,
      worktree: '/alpha/tree-b',
    },
  ])
  expect(conditions.map((condition) => condition.kind)).toEqual([
    'shared-reader-tree-dirty',
    'duplicate-reader-clone',
  ])
  expect(conditions[0]!.detail).toContain('41000000-0000-4000-8000-000000000000')
  expect(conditions[1]!.detail).toContain('/alpha/tree-b')
})
