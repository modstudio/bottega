// concern: store-hooks
/** Knows which database lifecycle hooks provide evidence hygiene, run liveness, and workflow seeds. Must not know CLI commands, run execution, transports, routing, or worktrees. */
import { ensureMachineIdentity, registerOpenHooks } from '../database/db.ts'
import { excludeSharedOutputRuns } from '../evidence/evidence-query.ts'
import { seedLenses } from '../lens/lens-seeds.ts'
import { reapStale } from '../run/run-liveness.ts'
import { enqueueChangedReviewRounds } from '../review/review-outbox.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'

let registered = false

export function registerStandardHooks(): void {
  if (registered) return
  registerOpenHooks({
    afterWritableOpen: [ensureMachineIdentity, excludeSharedOutputRuns, reapStale],
    afterInitialize: [
      ensureMachineIdentity,
      excludeSharedOutputRuns,
      enqueueChangedReviewRounds,
      seedLenses,
      seedWorkflows,
    ],
  })
  registered = true
}
