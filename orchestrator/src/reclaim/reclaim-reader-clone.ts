// concern: reclaim reader-clone creation safety
/** Refuses removal while an unmarked reader clone may still be in creation. */

import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import type { ReaderCloneCreator } from '../worktree/worktree-attribution.ts'

export type ReaderCloneRunFact = { recordId: string; status: string }

export type ReaderCloneReclaimDecision = { allowed: true } | { allowed: false; reason: string }

/** Point explicit reclaim of a run-named unmarked reader clone at automatic sweep. */
export function unmarkedReaderCloneReclaimRefusal(input: {
  runId: string
  run: ReaderCloneRunFact | null
  uniqueCommitCount: number | null
  dirty: boolean
  dirtyDetail: string
  platformSlug: string
}): string {
  const prefix =
    `${input.platformSlug} machine sweep reclaims this unmarked tree once run ${input.runId} ` +
    'is terminal and it holds no unique work; '
  if (!input.run) return `${prefix}condition failed: the run has no run record`
  if (!TERMINAL_RUN_STATUS_SET.has(input.run.status)) {
    return `${prefix}condition failed: run status ${input.run.status} is not terminal`
  }
  if (input.uniqueCommitCount === null) {
    return `${prefix}condition failed: commits not on main could not be counted`
  }
  if (input.uniqueCommitCount > 0) {
    const noun = input.uniqueCommitCount === 1 ? 'commit' : 'commits'
    return `${prefix}condition failed: it holds ${input.uniqueCommitCount} ${noun} not on main`
  }
  if (input.dirty) return `${prefix}condition failed: it ${input.dirtyDetail}`
  return `${prefix}both conditions are met; run ${input.platformSlug} machine sweep`
}

/** Decide from recorded project runs whether reclaim can rule out an in-progress clone create. */
export function readerCloneReclaimDecision(
  creator: ReaderCloneCreator,
  projectRuns: readonly ReaderCloneRunFact[],
): ReaderCloneReclaimDecision {
  if (creator.kind === 'run') {
    const creatingRun = projectRuns.find(
      (run) => run.recordId === creator.runId && !TERMINAL_RUN_STATUS_SET.has(run.status),
    )
    return creatingRun
      ? {
          allowed: false,
          reason: `run ${creatingRun.recordId} status ${creatingRun.status} is not terminal and may still be creating this reader clone`,
        }
      : { allowed: true }
  }
  const liveRun = projectRuns.find((run) => !TERMINAL_RUN_STATUS_SET.has(run.status))
  return liveRun
    ? {
        allowed: false,
        reason: `run ${liveRun.recordId} status ${liveRun.status} is not terminal; the shared review clone may still be in creation`,
      }
    : { allowed: true }
}
