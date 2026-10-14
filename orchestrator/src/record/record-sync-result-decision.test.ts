import { expect, test } from 'bun:test'
import { recordSyncResultTreatments } from './record-sync-result-decision.ts'

test('same-batch failures hold their children pending transitively', () => {
  expect(
    recordSyncResultTreatments(
      [
        { id: 1, sameBatchParentIds: [] },
        { id: 2, sameBatchParentIds: [1] },
        { id: 3, sameBatchParentIds: [2] },
        { id: 4, sameBatchParentIds: [] },
        { id: 5, sameBatchParentIds: [4] },
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

test('a synced child of an unsynced same-batch parent violates the contract', () => {
  expect(() =>
    recordSyncResultTreatments(
      [
        { id: 10, sameBatchParentIds: [] },
        { id: 11, sameBatchParentIds: [10] },
      ],
      [
        { id: 10, status: 'quarantined', reason: 'parent refused' },
        { id: 11, status: 'synced' },
      ],
    ),
  ).toThrow('record sync contract violation: row 11')
})
