import { expect, test } from 'bun:test'
import { recordSyncResultTreatments } from './record-sync-result-decision.ts'

test('same-batch failures hold their children pending transitively', () => {
  expect(
    recordSyncResultTreatments(
      [
        { id: 1, sameBatchParentIdGroups: [] },
        { id: 2, sameBatchParentIdGroups: [[1]] },
        { id: 3, sameBatchParentIdGroups: [[2]] },
        { id: 4, sameBatchParentIdGroups: [] },
        { id: 5, sameBatchParentIdGroups: [[4]] },
      ],
      [
        { id: 1, status: 'quarantined', reason: 'parent refused' },
        { id: 2, status: 'quarantined', reason: 'missing parent' },
        { id: 3, status: 'deferred', reason: 'waiting', spaceId: 'space' },
        { id: 4, status: 'synced' },
        { id: 5, status: 'quarantined', reason: 'own refusal' },
      ],
    ),
  ).toEqual([
    { id: 1, treatment: 'apply' },
    { id: 2, treatment: 'pending' },
    { id: 3, treatment: 'pending' },
    { id: 4, treatment: 'apply' },
    { id: 5, treatment: 'apply' },
  ])
})

test('parent identity groups accept any synced copy and require every identity', () => {
  expect(
    recordSyncResultTreatments(
      [
        { id: 10, sameBatchParentIdGroups: [] },
        { id: 11, sameBatchParentIdGroups: [] },
        { id: 12, sameBatchParentIdGroups: [[10, 11]] },
        { id: 13, sameBatchParentIdGroups: [[10], [11]] },
      ],
      [
        { id: 10, status: 'synced' },
        { id: 11, status: 'quarantined', reason: 'duplicate refused' },
        { id: 12, status: 'synced' },
        { id: 13, status: 'quarantined', reason: 'one identity refused' },
      ],
    ),
  ).toEqual([
    { id: 10, treatment: 'apply' },
    { id: 11, treatment: 'apply' },
    { id: 12, treatment: 'apply' },
    { id: 13, treatment: 'pending' },
  ])
})
