// concern: cleanup-sweep-decisions

export const UNJUDGED_OWNER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export type AbsentClaimFacts = {
  probe: 'present' | 'absent' | 'failed'
  owningRepository: 'known' | 'unknown-present' | 'unknown-absent'
  allTurnsTerminal: boolean
  liveLeaseOrPid: boolean
  landingInFlight: boolean
  branchKept: boolean
}

export type AbsentClaimRuling = { action: 'settle-absent' } | { action: 'keep'; reason: string }

/** Decide whether one claimed resource is known to have disappeared after its conversation ended. */
export function decideAbsentClaim(facts: AbsentClaimFacts): AbsentClaimRuling {
  if (facts.owningRepository === 'unknown-present')
    return { action: 'keep', reason: 'owning repository unknown' }
  if (facts.probe === 'failed') return { action: 'keep', reason: 'absence probe failed' }
  if (facts.probe === 'present') return { action: 'keep', reason: 'resource is present' }
  if (!facts.allTurnsTerminal) return { action: 'keep', reason: 'conversation has a live turn' }
  if (facts.liveLeaseOrPid)
    return { action: 'keep', reason: 'conversation has a live lease or pid' }
  if (facts.landingInFlight) return { action: 'keep', reason: 'landing is in flight' }
  if (facts.branchKept) return { action: 'keep', reason: 'missing kept branch requires restore' }
  return { action: 'settle-absent' }
}

export type UnjudgedOwnerFacts = {
  ownerSessionId: string | null
  ownerLastSeenAt: number | null
  runLastActivityAt: number
  now: number
  windowMs: number
}

function ownerIsGone(facts: UnjudgedOwnerFacts): boolean {
  if (facts.ownerSessionId === null) return true
  const ownerLastActivity = Math.max(facts.ownerLastSeenAt ?? -Infinity, facts.runLastActivityAt)
  return facts.now - ownerLastActivity > facts.windowMs
}

/** Decide whether an owed judgment still has a live-enough owner to provide it. */
export function shouldExpireUnjudgedOwner(facts: UnjudgedOwnerFacts): boolean {
  return ownerIsGone(facts)
}

export const UNATTENDED_RECLAIM_KINDS = [
  'stale-run',
  'process',
  'ref-guard',
  'retained-ref',
  'sandbox',
] as const

export type UnattendedReclaimKind = (typeof UNATTENDED_RECLAIM_KINDS)[number]
export type UnattendedReclaimFacts = UnjudgedOwnerFacts & {
  kind: string
  liveness: 'dead' | 'live' | 'unknown'
  uncommittedWork: boolean | 'unknown'
  runRecordExists: boolean
}
export type UnattendedReclaimRuling = { action: 'allow' } | { action: 'keep'; reason: string }

/** Decide whether residue is safe for the scheduled, non-interactive reclaim pass. */
export function decideUnattendedReclaim(facts: UnattendedReclaimFacts): UnattendedReclaimRuling {
  if (!UNATTENDED_RECLAIM_KINDS.some((kind) => kind === facts.kind))
    return { action: 'keep', reason: 'residue kind is not allowed for unattended reclaim' }
  if (!facts.runRecordExists) return { action: 'keep', reason: 'run record is absent' }
  if (!ownerIsGone(facts)) return { action: 'keep', reason: 'owner session is not gone' }
  if (facts.liveness !== 'dead')
    return { action: 'keep', reason: `${facts.liveness} liveness is not dead` }
  if (facts.uncommittedWork !== false)
    return { action: 'keep', reason: 'uncommitted work is present or could not be inspected' }
  return { action: 'allow' }
}

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
