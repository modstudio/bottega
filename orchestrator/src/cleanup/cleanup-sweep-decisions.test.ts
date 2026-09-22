import { describe, expect, test } from 'bun:test'
import {
  decideFilesystemOrphanSweep,
  decideRecordedRunSweep,
  type FilesystemOrphanSweepFacts,
  type RecordedRunSweepFacts,
} from './cleanup-sweep-decisions.ts'

const recordedBase: RecordedRunSweepFacts = {
  dry: false,
  pointerUnchanged: true,
  preInventory: 'ok',
  closeOutcome: 'held',
  closeDetail: 'held for review',
  postInventory: null,
}

describe('recorded run sweep ruling', () => {
  const cases: Array<{
    name: string
    facts: Partial<RecordedRunSweepFacts>
    expected: ReturnType<typeof decideRecordedRunSweep>
  }> = [
    {
      name: 'a changed pointer skips before an unavailable inventory matters',
      facts: { pointerUnchanged: false, preInventory: 'unavailable' },
      expected: { action: 'skip', cleanupFailed: false },
    },
    {
      name: 'an unavailable pre-inventory is kept and fails cleanup',
      facts: { preInventory: 'unavailable' },
      expected: {
        action: 'keep',
        keepReason: 'inventory unavailable',
        presentationError: 'inventory unavailable',
        cleanupFailed: true,
      },
    },
    {
      name: 'dry released close-out is reported immediately',
      facts: { dry: true, preInventory: 'not-needed', closeOutcome: 'released' },
      expected: { action: 'released', cleanupFailed: false },
    },
    {
      name: 'dry absent close-out is reported immediately',
      facts: { dry: true, preInventory: 'not-needed', closeOutcome: 'absent' },
      expected: { action: 'absent', cleanupFailed: false },
    },
    {
      name: 'a forgotten close-out is reported immediately',
      facts: { closeOutcome: 'forgotten' },
      expected: { action: 'released', cleanupFailed: false },
    },
    {
      name: 'an empty post-inventory releases the row',
      facts: { closeOutcome: 'released', postInventory: 'empty' },
      expected: { action: 'released', cleanupFailed: false },
    },
    {
      name: 'an empty post-inventory reports an absent row',
      facts: { closeOutcome: 'absent', postInventory: 'empty' },
      expected: { action: 'absent', cleanupFailed: false },
    },
    {
      name: 'an unavailable post-inventory is kept and fails cleanup',
      facts: { closeOutcome: 'released', postInventory: 'unavailable' },
      expected: {
        action: 'keep',
        keepReason: 'inventory unavailable',
        presentationError: 'inventory unavailable',
        cleanupFailed: true,
      },
    },
    {
      name: 'a released close-out with leaked post-inventory is a leak',
      facts: { closeOutcome: 'released', postInventory: 'leaked' },
      expected: {
        action: 'leak',
        keepReason: 'leaked Docker resources',
        presentationError: 'remove tool leaked Docker resources',
        cleanupFailed: true,
      },
    },
    {
      name: 'a failed close-out fails cleanup',
      facts: { closeOutcome: 'failed', closeDetail: 'remove failed' },
      expected: {
        action: 'fail',
        keepReason: 'remove failed',
        presentationError: 'remove failed',
        cleanupFailed: true,
      },
    },
    {
      name: 'an explicit keep-tree hold retains its clearing instruction',
      facts: {
        closeOutcome: 'held',
        closeDetail: 'held by explicit --keep-tree until cleared',
      },
      expected: {
        action: 'keep',
        keepReason: 'held by explicit --keep-tree; clear with orch discard <run-id>',
        cleanupFailed: false,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () => {
      expect(decideRecordedRunSweep({ ...recordedBase, ...row.facts })).toEqual(row.expected)
    })
  }
})

const orphanBase: FilesystemOrphanSweepFacts = {
  orchOwned: true,
  alive: false,
  safe: { removable: true, detail: 'safe to remove', branch: 'orch-1' },
  dry: false,
  phase: 'before',
  sharers: 0,
  lockedAlive: false,
  removed: false,
  ownershipRefusal: null,
  ownershipWarning: null,
  inventory: 'skipped',
}

describe('filesystem orphan sweep ruling', () => {
  const cases: Array<{
    name: string
    facts: Partial<FilesystemOrphanSweepFacts>
    action: ReturnType<typeof decideFilesystemOrphanSweep>['action']
    keep?: [string, string]
    failed?: boolean
  }> = [
    {
      name: 'a tree not created by orch is kept',
      facts: { orchOwned: false },
      action: 'not-owned',
      keep: ['kept: not created by orch', 'not created by orch'],
    },
    {
      name: 'a live orphan is never removed even when safe',
      facts: { alive: true },
      action: 'live',
      keep: ['live — kept', 'live — kept'],
    },
    {
      name: 'an orphan that becomes live under the lock is kept',
      facts: { lockedAlive: true },
      action: 'live',
      keep: ['live — kept', 'live — kept'],
    },
    {
      name: 'an unsafe orphan keeps the safety detail',
      facts: { safe: { removable: false, detail: 'has local changes', branch: 'orch-1' } },
      action: 'unsafe',
      keep: ['has local changes', 'has local changes'],
    },
    {
      name: 'unreachable commits use the concise keep reason',
      facts: {
        safe: {
          removable: false,
          detail: 'has commits not reachable from main',
          branch: 'orch-1',
        },
      },
      action: 'unsafe',
      keep: ['has commits not reachable from main', 'holds commits not on trunk'],
    },
    {
      name: 'a dry run reports would-reclaim before removal facts',
      facts: { dry: true, sharers: 2, lockedAlive: false, removed: true },
      action: 'would-reclaim',
    },
    { name: 'a safe orphan proceeds to removal', facts: {}, action: 'remove' },
    {
      name: 'sharers before removal refuse',
      facts: { sharers: 1 },
      action: 'shared-before',
      keep: ['acquired by run(s)', 'shared with live run(s)'],
      failed: true,
    },
    {
      name: 'ownership refusal after removal is final',
      facts: { phase: 'after', removed: true, ownershipRefusal: 'branch owner changed' },
      action: 'removal-refused',
      keep: ['removal refused', 'removal refused'],
      failed: true,
    },
    {
      name: 'sharers after removal report acquired-during-cleanup',
      facts: { phase: 'after', sharers: 1, removed: true },
      action: 'shared-after',
      keep: ['acquired during cleanup by run(s)', 'shared with live run(s)'],
      failed: true,
    },
    {
      name: 'a refused remove result is kept',
      facts: { phase: 'after', removed: false },
      action: 'removal-refused',
      keep: ['removal refused', 'removal refused'],
      failed: true,
    },
    {
      name: 'unavailable inventory is kept',
      facts: { phase: 'after', removed: true, inventory: 'unavailable' },
      action: 'inventory-unavailable',
      keep: ['inventory unavailable', 'inventory unavailable'],
      failed: true,
    },
    {
      name: 'leaked inventory is kept',
      facts: { phase: 'after', removed: true, inventory: 'leaked' },
      action: 'leaked',
      keep: ['leaked Docker resources', 'leaked Docker resources'],
      failed: true,
    },
    {
      name: 'empty inventory reports reclaimed',
      facts: { phase: 'after', removed: true, inventory: 'empty' },
      action: 'reclaimed',
    },
    {
      name: 'a null run id maps to skipped inventory and the tree counts reclaimed',
      facts: { phase: 'after', removed: true, inventory: 'skipped' },
      action: 'reclaimed',
    },
  ]

  for (const row of cases) {
    test(row.name, () => {
      const ruling = decideFilesystemOrphanSweep({ ...orphanBase, ...row.facts })
      expect(ruling.action).toBe(row.action)
      expect(ruling.cleanupFailed).toBe(row.failed ?? false)
      expect([ruling.keepLine, ruling.keepReason]).toEqual(row.keep ?? [undefined, undefined])
    })
  }

  test('an ownership warning is carried to presentation without changing reclamation', () => {
    expect(
      decideFilesystemOrphanSweep({
        ...orphanBase,
        phase: 'after',
        removed: true,
        inventory: 'empty',
        ownershipWarning: 'branch already absent',
      }),
    ).toEqual({
      action: 'reclaimed',
      ownershipWarning: 'branch already absent',
      cleanupFailed: false,
    })
  })
})
