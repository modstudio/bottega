// concern: cleanup-sweep-decisions

export function isSweepCandidate(input: {
  status: string
  worktree: string | null
  closeOutOutcome: string | null
}): boolean {
  return (
    ['ok', 'failed', 'stale', 'stopped'].includes(input.status) &&
    (input.worktree !== null || ['held', 'failed'].includes(input.closeOutOutcome ?? ''))
  )
}

export type RecordedRunPointerFacts = { pointerUnchanged: boolean }
export type RecordedRunPointerRuling = { action: 'skip' | 'proceed' }

/** Decide whether a recorded row still names the tree selected by the sweep query. */
export function decideRecordedRunPointer(facts: RecordedRunPointerFacts): RecordedRunPointerRuling {
  return { action: facts.pointerUnchanged ? 'proceed' : 'skip' }
}

export type RecordedRunPreInventoryFacts = {
  inventory: 'unavailable' | 'ok' | 'not-needed'
}
export type RecordedRunPreInventoryRuling =
  | { action: 'proceed'; cleanupFailed: false }
  | {
      action: 'keep'
      keepReason: 'inventory unavailable'
      presentationError: 'inventory unavailable'
      cleanupFailed: true
    }

/** Decide whether close-out may begin after the optional pre-removal inventory. */
export function decideRecordedRunPreInventory(
  facts: RecordedRunPreInventoryFacts,
): RecordedRunPreInventoryRuling {
  if (facts.inventory === 'unavailable') {
    return {
      action: 'keep',
      keepReason: 'inventory unavailable',
      presentationError: 'inventory unavailable',
      cleanupFailed: true,
    }
  }
  return { action: 'proceed', cleanupFailed: false }
}

export type RecordedRunCloseOutFacts = {
  dry: boolean
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  detail: string
}
export type RecordedRunCloseOutRuling =
  | { action: 'report'; cleanupFailed: false }
  | {
      action: 'proceed'
      closeOutcome: 'released' | 'absent'
      cleanupFailed: false
    }
  | { action: 'keep'; keepReason: string; cleanupFailed: false }
  | {
      action: 'fail'
      keepReason: string
      presentationError: string
      cleanupFailed: true
    }

/** Decide a completed close-out before any required post-removal inventory. */
export function decideRecordedRunCloseOut(
  facts: RecordedRunCloseOutFacts,
): RecordedRunCloseOutRuling {
  if (
    (facts.dry || facts.outcome === 'forgotten') &&
    ['released', 'absent', 'forgotten'].includes(facts.outcome)
  ) {
    return { action: 'report', cleanupFailed: false }
  }
  if (facts.outcome === 'released' || facts.outcome === 'absent') {
    return {
      action: 'proceed',
      closeOutcome: facts.outcome,
      cleanupFailed: false,
    }
  }
  const keepReason = facts.detail.startsWith('held by explicit --keep-tree')
    ? 'held by explicit --keep-tree; clear with orch discard <run-id>'
    : facts.detail
  if (facts.outcome === 'failed') {
    return {
      action: 'fail',
      keepReason,
      presentationError: facts.detail,
      cleanupFailed: true,
    }
  }
  return { action: 'keep', keepReason, cleanupFailed: false }
}

export type RecordedRunPostInventoryFacts = {
  closeOutcome: 'released' | 'absent'
  inventory: 'unavailable' | 'empty' | 'leaked'
}
export type RecordedRunPostInventoryRuling =
  | {
      action: 'inventory-unavailable'
      keepReason: 'inventory unavailable'
      presentationError: 'inventory unavailable'
      cleanupFailed: true
    }
  | {
      action: 'leak'
      keepReason: 'leaked Docker resources'
      presentationError: 'remove tool leaked Docker resources'
      cleanupFailed: true
    }
  | { action: 'released' | 'absent'; cleanupFailed: false }

/** Decide a recorded row after the removal tool has completed and resources are inventoried. */
export function decideRecordedRunPostInventory(
  facts: RecordedRunPostInventoryFacts,
): RecordedRunPostInventoryRuling {
  if (facts.inventory === 'unavailable') {
    return {
      action: 'inventory-unavailable',
      keepReason: 'inventory unavailable',
      presentationError: 'inventory unavailable',
      cleanupFailed: true,
    }
  }
  if (facts.inventory === 'leaked') {
    return {
      action: 'leak',
      keepReason: 'leaked Docker resources',
      presentationError: 'remove tool leaked Docker resources',
      cleanupFailed: true,
    }
  }
  return { action: facts.closeOutcome, cleanupFailed: false }
}

export type FilesystemOrphanEligibilityFacts = {
  orchOwned: boolean
  alive: boolean
  safe: { removable: boolean; detail: string; branch: string | null }
  dry: boolean
}
export type FilesystemOrphanEligibilityRuling =
  | { action: 'keep'; keepLine: string; keepReason: string }
  | { action: 'dry-would-reclaim' }
  | { action: 'proceed' }

function orphanKeepReason(detail: string): string {
  return /^has commits not reachable from /.test(detail) ? 'holds commits not on trunk' : detail
}

/** Decide an orphan after its ownership, liveness, and removal safety are known. */
export function decideFilesystemOrphanEligibility(
  facts: FilesystemOrphanEligibilityFacts,
): FilesystemOrphanEligibilityRuling {
  if (!facts.orchOwned) {
    return {
      action: 'keep',
      keepLine: 'kept: not created by orch',
      keepReason: 'not created by orch',
    }
  }
  if (facts.alive)
    return {
      action: 'keep',
      keepLine: 'live — kept',
      keepReason: 'live — kept',
    }
  if (!facts.safe.removable) {
    return {
      action: 'keep',
      keepLine: facts.safe.detail,
      keepReason: orphanKeepReason(facts.safe.detail),
    }
  }
  return { action: facts.dry ? 'dry-would-reclaim' : 'proceed' }
}

export type FilesystemOrphanUnderLockFacts = {
  sharers: number
  lockedAlive: boolean
}
export type FilesystemOrphanUnderLockRuling =
  | {
      action: 'shared-before'
      keepLine: 'acquired by run(s)'
      keepReason: 'shared with live run(s)'
      cleanupFailed: true
    }
  | {
      action: 'live'
      keepLine: 'live — kept'
      keepReason: 'live — kept'
      cleanupFailed: false
    }
  | { action: 'remove'; cleanupFailed: false }

/** Recheck acquisition and liveness under the cleanup lock before removal. */
export function decideFilesystemOrphanUnderLock(
  facts: FilesystemOrphanUnderLockFacts,
): FilesystemOrphanUnderLockRuling {
  if (facts.sharers > 0) {
    return {
      action: 'shared-before',
      keepLine: 'acquired by run(s)',
      keepReason: 'shared with live run(s)',
      cleanupFailed: true,
    }
  }
  if (facts.lockedAlive) {
    return {
      action: 'live',
      keepLine: 'live — kept',
      keepReason: 'live — kept',
      cleanupFailed: false,
    }
  }
  return { action: 'remove', cleanupFailed: false }
}

export type FilesystemOrphanAfterRemovalFacts = {
  removed: boolean
  removeDetail: string
  sharers: number
  ownershipRefusal: string | null
  ownershipWarning: string | null
}
export type FilesystemOrphanAfterRemovalRuling =
  | {
      action: 'removal-refused'
      error: string
      keepLine: 'removal refused'
      keepReason: 'removal refused'
      ownershipWarning: string | null
      cleanupFailed: true
    }
  | {
      action: 'shared-after'
      keepLine: 'acquired during cleanup by run(s)'
      keepReason: 'shared with live run(s)'
      ownershipWarning: string | null
      cleanupFailed: true
    }
  | {
      action: 'proceed'
      ownershipWarning: string | null
      cleanupFailed: false
    }

/** Decide whether removal completed without an ownership race or a new live sharer. */
export function decideFilesystemOrphanAfterRemoval(
  facts: FilesystemOrphanAfterRemovalFacts,
): FilesystemOrphanAfterRemovalRuling {
  if (facts.ownershipRefusal || !facts.removed) {
    return {
      action: 'removal-refused',
      error: facts.ownershipRefusal ?? facts.removeDetail,
      keepLine: 'removal refused',
      keepReason: 'removal refused',
      ownershipWarning: facts.ownershipWarning,
      cleanupFailed: true,
    }
  }
  if (facts.sharers > 0) {
    return {
      action: 'shared-after',
      keepLine: 'acquired during cleanup by run(s)',
      keepReason: 'shared with live run(s)',
      ownershipWarning: facts.ownershipWarning,
      cleanupFailed: true,
    }
  }
  return {
    action: 'proceed',
    ownershipWarning: facts.ownershipWarning,
    cleanupFailed: false,
  }
}

export type FilesystemOrphanAfterInventoryFacts = {
  runIdPresent: boolean
  inventory: 'unavailable' | 'empty' | 'leaked'
}
export type FilesystemOrphanAfterInventoryRuling =
  | {
      action: 'inventory-unavailable'
      keepLine: 'inventory unavailable'
      keepReason: 'inventory unavailable'
      cleanupFailed: true
    }
  | {
      action: 'leaked'
      keepLine: 'leaked Docker resources'
      keepReason: 'leaked Docker resources'
      cleanupFailed: true
    }
  | { action: 'reclaimed'; cleanupFailed: false }

/** Decide final reclamation after the optional run resource inventory. */
export function decideFilesystemOrphanAfterInventory(
  facts: FilesystemOrphanAfterInventoryFacts,
): FilesystemOrphanAfterInventoryRuling {
  if (facts.runIdPresent && facts.inventory === 'unavailable') {
    return {
      action: 'inventory-unavailable',
      keepLine: 'inventory unavailable',
      keepReason: 'inventory unavailable',
      cleanupFailed: true,
    }
  }
  if (facts.runIdPresent && facts.inventory === 'leaked') {
    return {
      action: 'leaked',
      keepLine: 'leaked Docker resources',
      keepReason: 'leaked Docker resources',
      cleanupFailed: true,
    }
  }
  return { action: 'reclaimed', cleanupFailed: false }
}
