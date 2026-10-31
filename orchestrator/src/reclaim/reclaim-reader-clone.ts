// concern: reclaim reader-clone creation safety
/** Refuses removal while an unmarked reader clone may still be in creation. */

import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import type { ReaderCloneCreator } from '../worktree/worktree-attribution.ts'

export type ReaderCloneRunFact = { recordId: string; status: string }

export type ReaderCloneReclaimDecision = { allowed: true } | { allowed: false; reason: string }

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
