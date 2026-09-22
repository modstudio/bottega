// concern: cleanup-sweep-decisions

export type RecordedRunSweepFacts = {
  dry: boolean
  pointerUnchanged: boolean
  preInventory: 'unavailable' | 'ok' | 'not-needed'
  closeOutcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed'
  closeDetail: string
  postInventory: 'unavailable' | 'empty' | 'leaked' | null
}

export type RecordedRunSweepRuling = {
  action: 'skip' | 'keep' | 'released' | 'absent' | 'leak' | 'fail'
  keepReason?: string
  presentationError?: string
  cleanupFailed: boolean
}

/** Decide a recorded run's sweep result after the caller gathers any required inventories. */
export function decideRecordedRunSweep(facts: RecordedRunSweepFacts): RecordedRunSweepRuling {
  if (!facts.pointerUnchanged) return { action: 'skip', cleanupFailed: false }
  if (facts.preInventory === 'unavailable') {
    return {
      action: 'keep',
      keepReason: 'inventory unavailable',
      presentationError: 'inventory unavailable',
      cleanupFailed: true,
    }
  }
  if (
    (facts.dry || facts.closeOutcome === 'forgotten') &&
    ['released', 'absent', 'forgotten'].includes(facts.closeOutcome)
  ) {
    return {
      action: facts.closeOutcome === 'absent' ? 'absent' : 'released',
      cleanupFailed: false,
    }
  }
  if (facts.closeOutcome === 'released' || facts.closeOutcome === 'absent') {
    if (facts.postInventory === 'unavailable') {
      return {
        action: 'keep',
        keepReason: 'inventory unavailable',
        presentationError: 'inventory unavailable',
        cleanupFailed: true,
      }
    }
    if (facts.postInventory === 'leaked') {
      return {
        action: 'leak',
        keepReason: 'leaked Docker resources',
        presentationError: 'remove tool leaked Docker resources',
        cleanupFailed: true,
      }
    }
    return { action: facts.closeOutcome, cleanupFailed: false }
  }
  const keepReason = facts.closeDetail.startsWith('held by explicit --keep-tree')
    ? 'held by explicit --keep-tree; clear with orch discard <run-id>'
    : facts.closeDetail
  if (facts.closeOutcome === 'failed') {
    return {
      action: 'fail',
      keepReason,
      presentationError: facts.closeDetail,
      cleanupFailed: true,
    }
  }
  return { action: 'keep', keepReason, cleanupFailed: false }
}

export type FilesystemOrphanSweepFacts = {
  orchOwned: boolean
  alive: boolean
  safe: { removable: boolean; detail: string; branch: string | null }
  dry: boolean
  phase: 'before' | 'after'
  sharers: number
  lockedAlive: boolean
  removed: boolean
  ownershipRefusal: string | null
  ownershipWarning: string | null
  inventory: 'unavailable' | 'empty' | 'leaked' | 'skipped'
}

export type FilesystemOrphanSweepRuling = {
  action:
    | 'not-owned'
    | 'live'
    | 'unsafe'
    | 'would-reclaim'
    | 'remove'
    | 'shared-before'
    | 'removal-refused'
    | 'shared-after'
    | 'inventory-unavailable'
    | 'leaked'
    | 'reclaimed'
  keepLine?: string
  keepReason?: string
  ownershipWarning: string | null
  cleanupFailed: boolean
}

function orphanKeepReason(detail: string): string {
  return /^has commits not reachable from /.test(detail) ? 'holds commits not on trunk' : detail
}

/** Decide an orphan's next sweep action from observations made outside the cleanup lock or in it. */
export function decideFilesystemOrphanSweep(
  facts: FilesystemOrphanSweepFacts,
): FilesystemOrphanSweepRuling {
  const ruling = (
    action: FilesystemOrphanSweepRuling['action'],
    cleanupFailed: boolean,
    keepLine?: string,
    keepReason?: string,
  ): FilesystemOrphanSweepRuling => ({
    action,
    ...(keepLine === undefined ? {} : { keepLine }),
    ...(keepReason === undefined ? {} : { keepReason }),
    ownershipWarning: facts.ownershipWarning,
    cleanupFailed,
  })

  if (!facts.orchOwned)
    return ruling('not-owned', false, 'kept: not created by orch', 'not created by orch')
  if (facts.alive || facts.lockedAlive) return ruling('live', false, 'live — kept', 'live — kept')
  if (!facts.safe.removable)
    return ruling('unsafe', false, facts.safe.detail, orphanKeepReason(facts.safe.detail))
  if (facts.dry) return ruling('would-reclaim', false)
  if (facts.phase === 'before') {
    if (facts.sharers > 0)
      return ruling('shared-before', true, 'acquired by run(s)', 'shared with live run(s)')
    return ruling('remove', false)
  }
  if (facts.ownershipRefusal)
    return ruling('removal-refused', true, 'removal refused', 'removal refused')
  if (facts.sharers > 0)
    return ruling(
      'shared-after',
      true,
      'acquired during cleanup by run(s)',
      'shared with live run(s)',
    )
  if (!facts.removed) return ruling('removal-refused', true, 'removal refused', 'removal refused')
  if (facts.inventory === 'unavailable')
    return ruling('inventory-unavailable', true, 'inventory unavailable', 'inventory unavailable')
  if (facts.inventory === 'leaked')
    return ruling('leaked', true, 'leaked Docker resources', 'leaked Docker resources')
  return ruling('reclaimed', false)
}
