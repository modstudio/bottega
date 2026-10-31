// concern: reclaim reader-clone creation safety
/** Refuses removal while an unmarked reader clone may still be in creation. */

import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'

export type ReaderCloneRunFact = { recordId: string; status: string }

export type ReaderCloneReclaimDecision = { allowed: true } | { allowed: false; reason: string }

const RUN_READER_BASENAME =
  /^orch-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const SHARED_REVIEW_BASENAME = /^orch-review-[0-9a-f]{12}$/

/** Decide from recorded project runs whether reclaim can rule out an in-progress clone create. */
export function readerCloneReclaimDecision(
  basename: string,
  projectRuns: readonly ReaderCloneRunFact[],
): ReaderCloneReclaimDecision {
  const creatingRunId = RUN_READER_BASENAME.exec(basename)?.[1]
  if (creatingRunId) {
    const creatingRun = projectRuns.find(
      (run) => run.recordId === creatingRunId && !TERMINAL_RUN_STATUS_SET.has(run.status),
    )
    return creatingRun
      ? {
          allowed: false,
          reason: `run ${creatingRun.recordId} status ${creatingRun.status} is not terminal and may still be creating this reader clone`,
        }
      : { allowed: true }
  }
  if (SHARED_REVIEW_BASENAME.test(basename)) {
    const liveRun = projectRuns.find((run) => !TERMINAL_RUN_STATUS_SET.has(run.status))
    return liveRun
      ? {
          allowed: false,
          reason: `run ${liveRun.recordId} status ${liveRun.status} is not terminal; the shared review clone may still be in creation`,
        }
      : { allowed: true }
  }
  return { allowed: true }
}
