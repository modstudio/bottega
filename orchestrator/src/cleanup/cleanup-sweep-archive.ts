/** Applies the independent archive-retention policies used by cleanup sweep. */

import { pruneExpiredBranchDisposalArchives } from '../branch/branch-disposal.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { pruneReaderCloneArchives } from './reader-clone-archive-retention.ts'

export function pruneSweepArchives(input: {
  dryRun: boolean
  project?: string
  presentation: CleanupPresentation
}): { failed: boolean } {
  const reader = pruneReaderCloneArchives({
    dryRun: input.dryRun,
    presentation: input.presentation,
  })
  const branch = pruneExpiredBranchDisposalArchives({
    dryRun: input.dryRun,
    project: input.project,
    log: input.presentation.log,
    error: input.presentation.error,
  })
  return { failed: reader.failed > 0 || branch.failed }
}
