import { describe, expect, test } from 'bun:test'
import {
  decideFilesystemOrphanAfterInventory,
  decideFilesystemOrphanAfterRemoval,
  decideFilesystemOrphanEligibility,
  decideFilesystemOrphanUnderLock,
  decideRecordedRunCloseOut,
  decideRecordedRunPointer,
  decideRecordedRunPostInventory,
  decideRecordedRunPreInventory,
  type FilesystemOrphanAfterInventoryFacts,
  type FilesystemOrphanAfterRemovalFacts,
  type FilesystemOrphanEligibilityFacts,
  type FilesystemOrphanUnderLockFacts,
  isSweepCandidate,
  type RecordedRunCloseOutFacts,
  type RecordedRunPointerFacts,
  type RecordedRunPostInventoryFacts,
  type RecordedRunPreInventoryFacts,
} from './cleanup-sweep-decisions.ts'

describe('sweep candidate selection', () => {
  test('includes terminal held and failed close-outs after their pointer is cleared', () => {
    expect(
      isSweepCandidate({
        status: 'ok',
        worktree: null,
        closeOutOutcome: 'held',
      }),
    ).toBe(true)
    expect(
      isSweepCandidate({
        status: 'failed',
        worktree: null,
        closeOutOutcome: 'failed',
      }),
    ).toBe(true)
    expect(
      isSweepCandidate({
        status: 'ok',
        worktree: null,
        closeOutOutcome: 'absent',
      }),
    ).toBe(false)
    expect(
      isSweepCandidate({
        status: 'running',
        worktree: '/tree',
        closeOutOutcome: null,
      }),
    ).toBe(false)
  })
})

describe('recorded run pointer ruling', () => {
  const cases: Array<{
    name: string
    facts: RecordedRunPointerFacts
    action: ReturnType<typeof decideRecordedRunPointer>['action']
  }> = [
    {
      name: 'an unchanged pointer proceeds',
      facts: { pointerUnchanged: true },
      action: 'proceed',
    },
    {
      name: 'a changed pointer skips before inventory',
      facts: { pointerUnchanged: false },
      action: 'skip',
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideRecordedRunPointer(row.facts).action).toBe(row.action))
  }
})

describe('recorded run pre-inventory ruling', () => {
  const cases: Array<{
    name: string
    facts: RecordedRunPreInventoryFacts
    expected: ReturnType<typeof decideRecordedRunPreInventory>
  }> = [
    {
      name: 'an unavailable pre-inventory is kept and fails cleanup',
      facts: { inventory: 'unavailable' },
      expected: {
        action: 'keep',
        keepReason: 'inventory unavailable',
        presentationError: 'inventory unavailable',
        cleanupFailed: true,
      },
    },
    {
      name: 'an available pre-inventory proceeds',
      facts: { inventory: 'ok' },
      expected: { action: 'proceed', cleanupFailed: false },
    },
    {
      name: 'an unnecessary pre-inventory proceeds',
      facts: { inventory: 'not-needed' },
      expected: { action: 'proceed', cleanupFailed: false },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideRecordedRunPreInventory(row.facts)).toEqual(row.expected))
  }
})

describe('recorded run close-out ruling', () => {
  const cases: Array<{
    name: string
    facts: RecordedRunCloseOutFacts
    expected: ReturnType<typeof decideRecordedRunCloseOut>
  }> = [
    {
      name: 'dry released close-out is reported immediately',
      facts: { dry: true, outcome: 'released', detail: 'would release' },
      expected: { action: 'report', cleanupFailed: false },
    },
    {
      name: 'dry absent close-out is reported immediately',
      facts: { dry: true, outcome: 'absent', detail: 'already absent' },
      expected: { action: 'report', cleanupFailed: false },
    },
    {
      name: 'a forgotten close-out is reported immediately',
      facts: { dry: false, outcome: 'forgotten', detail: 'forgotten' },
      expected: { action: 'report', cleanupFailed: false },
    },
    {
      name: 'a released close-out proceeds to post-inventory',
      facts: { dry: false, outcome: 'released', detail: 'released' },
      expected: {
        action: 'proceed',
        closeOutcome: 'released',
        cleanupFailed: false,
      },
    },
    {
      name: 'an absent close-out proceeds to post-inventory',
      facts: { dry: false, outcome: 'absent', detail: 'absent' },
      expected: {
        action: 'proceed',
        closeOutcome: 'absent',
        cleanupFailed: false,
      },
    },
    {
      name: 'a failed close-out fails cleanup',
      facts: { dry: false, outcome: 'failed', detail: 'remove failed' },
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
        dry: false,
        outcome: 'held',
        detail: 'held by explicit --keep-tree until cleared',
      },
      expected: {
        action: 'keep',
        keepReason: 'held by explicit --keep-tree; clear with orch discard <run-id>',
        cleanupFailed: false,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideRecordedRunCloseOut(row.facts)).toEqual(row.expected))
  }
})

describe('recorded run post-inventory ruling', () => {
  const cases: Array<{
    name: string
    facts: RecordedRunPostInventoryFacts
    expected: ReturnType<typeof decideRecordedRunPostInventory>
  }> = [
    {
      name: 'an empty post-inventory releases the row',
      facts: { closeOutcome: 'released', inventory: 'empty' },
      expected: { action: 'released', cleanupFailed: false },
    },
    {
      name: 'an empty post-inventory reports an absent row',
      facts: { closeOutcome: 'absent', inventory: 'empty' },
      expected: { action: 'absent', cleanupFailed: false },
    },
    {
      name: 'an unavailable post-inventory is kept and fails cleanup',
      facts: { closeOutcome: 'released', inventory: 'unavailable' },
      expected: {
        action: 'inventory-unavailable',
        keepReason: 'inventory unavailable',
        presentationError: 'inventory unavailable',
        cleanupFailed: true,
      },
    },
    {
      name: 'a released close-out with leaked post-inventory is a leak',
      facts: { closeOutcome: 'released', inventory: 'leaked' },
      expected: {
        action: 'leak',
        keepReason: 'leaked Docker resources',
        presentationError: 'remove tool leaked Docker resources',
        cleanupFailed: true,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideRecordedRunPostInventory(row.facts)).toEqual(row.expected))
  }
})

describe('filesystem orphan eligibility ruling', () => {
  const safe = { removable: true, detail: 'safe to remove', branch: 'orch-1' }
  const cases: Array<{
    name: string
    facts: FilesystemOrphanEligibilityFacts
    expected: ReturnType<typeof decideFilesystemOrphanEligibility>
  }> = [
    {
      name: 'a tree not created by orch is kept',
      facts: { orchOwned: false, alive: false, safe, dry: false },
      expected: {
        action: 'keep',
        keepLine: 'kept: not created by orch',
        keepReason: 'not created by orch',
      },
    },
    {
      name: 'a live orphan is never removed even when safe',
      facts: { orchOwned: true, alive: true, safe, dry: false },
      expected: {
        action: 'keep',
        keepLine: 'live — kept',
        keepReason: 'live — kept',
      },
    },
    {
      name: 'an unsafe orphan keeps the safety detail',
      facts: {
        orchOwned: true,
        alive: false,
        safe: {
          removable: false,
          detail: 'has local changes',
          branch: 'orch-1',
        },
        dry: false,
      },
      expected: {
        action: 'keep',
        keepLine: 'has local changes',
        keepReason: 'has local changes',
      },
    },
    {
      name: 'unreachable commits use the concise keep reason',
      facts: {
        orchOwned: true,
        alive: false,
        safe: {
          removable: false,
          detail: 'has commits not reachable from main',
          branch: 'orch-1',
        },
        dry: false,
      },
      expected: {
        action: 'keep',
        keepLine: 'has commits not reachable from main',
        keepReason: 'holds commits not on trunk',
      },
    },
    {
      name: 'a dry run reports would-reclaim without removal facts',
      facts: { orchOwned: true, alive: false, safe, dry: true },
      expected: { action: 'dry-would-reclaim' },
    },
    {
      name: 'a safe orphan proceeds to the lock',
      facts: { orchOwned: true, alive: false, safe, dry: false },
      expected: { action: 'proceed' },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideFilesystemOrphanEligibility(row.facts)).toEqual(row.expected))
  }
})

describe('filesystem orphan under-lock ruling', () => {
  const cases: Array<{
    name: string
    facts: FilesystemOrphanUnderLockFacts
    expected: ReturnType<typeof decideFilesystemOrphanUnderLock>
  }> = [
    {
      name: 'sharers before removal refuse',
      facts: { sharers: 1, lockedAlive: false },
      expected: {
        action: 'shared-before',
        keepLine: 'acquired by run(s)',
        keepReason: 'shared with live run(s)',
        cleanupFailed: true,
      },
    },
    {
      name: 'sharers take precedence when the tree is also live',
      facts: { sharers: 1, lockedAlive: true },
      expected: {
        action: 'shared-before',
        keepLine: 'acquired by run(s)',
        keepReason: 'shared with live run(s)',
        cleanupFailed: true,
      },
    },
    {
      name: 'an orphan that becomes live under the lock is kept',
      facts: { sharers: 0, lockedAlive: true },
      expected: {
        action: 'live',
        keepLine: 'live — kept',
        keepReason: 'live — kept',
        cleanupFailed: false,
      },
    },
    {
      name: 'an unshared non-live orphan proceeds to removal',
      facts: { sharers: 0, lockedAlive: false },
      expected: { action: 'remove', cleanupFailed: false },
    },
  ]

  for (const row of cases) {
    test(row.name, () => expect(decideFilesystemOrphanUnderLock(row.facts)).toEqual(row.expected))
  }
})

describe('filesystem orphan after-removal ruling', () => {
  const cases: Array<{
    name: string
    facts: FilesystemOrphanAfterRemovalFacts
    expected: ReturnType<typeof decideFilesystemOrphanAfterRemoval>
  }> = [
    {
      name: 'ownership refusal after removal is final',
      facts: {
        removed: true,
        removeDetail: 'removed',
        sharers: 0,
        ownershipRefusal: 'branch owner changed',
        ownershipWarning: null,
      },
      expected: {
        action: 'removal-refused',
        error: 'branch owner changed',
        keepLine: 'removal refused',
        keepReason: 'removal refused',
        ownershipWarning: null,
        cleanupFailed: true,
      },
    },
    {
      name: 'sharers after removal report acquired-during-cleanup',
      facts: {
        removed: true,
        removeDetail: 'removed',
        sharers: 1,
        ownershipRefusal: null,
        ownershipWarning: null,
      },
      expected: {
        action: 'shared-after',
        keepLine: 'acquired during cleanup by run(s)',
        keepReason: 'shared with live run(s)',
        ownershipWarning: null,
        cleanupFailed: true,
      },
    },
    {
      name: 'a refused remove result carries its error text',
      facts: {
        removed: false,
        removeDetail: 'tool declined removal',
        sharers: 0,
        ownershipRefusal: null,
        ownershipWarning: null,
      },
      expected: {
        action: 'removal-refused',
        error: 'tool declined removal',
        keepLine: 'removal refused',
        keepReason: 'removal refused',
        ownershipWarning: null,
        cleanupFailed: true,
      },
    },
    {
      name: 'an ownership warning is carried while proceeding',
      facts: {
        removed: true,
        removeDetail: 'removed',
        sharers: 0,
        ownershipRefusal: null,
        ownershipWarning: 'branch already absent',
      },
      expected: {
        action: 'proceed',
        ownershipWarning: 'branch already absent',
        cleanupFailed: false,
      },
    },
  ]

  for (const row of cases) {
    test(row.name, () =>
      expect(decideFilesystemOrphanAfterRemoval(row.facts)).toEqual(row.expected),
    )
  }
})

describe('filesystem orphan after-inventory ruling', () => {
  const cases: Array<{
    name: string
    facts: FilesystemOrphanAfterInventoryFacts
    expected: ReturnType<typeof decideFilesystemOrphanAfterInventory>
  }> = [
    {
      name: 'unavailable inventory is kept',
      facts: { runIdPresent: true, inventory: 'unavailable' },
      expected: {
        action: 'inventory-unavailable',
        keepLine: 'inventory unavailable',
        keepReason: 'inventory unavailable',
        cleanupFailed: true,
      },
    },
    {
      name: 'leaked inventory is kept',
      facts: { runIdPresent: true, inventory: 'leaked' },
      expected: {
        action: 'leaked',
        keepLine: 'leaked Docker resources',
        keepReason: 'leaked Docker resources',
        cleanupFailed: true,
      },
    },
    {
      name: 'empty inventory reports reclaimed',
      facts: { runIdPresent: true, inventory: 'empty' },
      expected: { action: 'reclaimed', cleanupFailed: false },
    },
    {
      name: 'a null run id means inventory is skipped and the tree counts reclaimed',
      facts: { runIdPresent: false, inventory: 'empty' },
      expected: { action: 'reclaimed', cleanupFailed: false },
    },
  ]

  for (const row of cases) {
    test(row.name, () =>
      expect(decideFilesystemOrphanAfterInventory(row.facts)).toEqual(row.expected),
    )
  }
})
