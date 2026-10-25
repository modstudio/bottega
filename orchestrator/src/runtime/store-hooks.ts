// concern: store-hooks
/** Knows which database lifecycle hooks provide evidence hygiene, run liveness, and workflow seeds. Must not know CLI commands, run execution, transports, routing, or worktrees. */
import { ensureMachineIdentity, registerOpenHooks } from '../database/db.ts'
import { excludeSharedOutputRuns } from '../evidence/evidence-query.ts'
import { seedLenses } from '../lens/lens-seeds.ts'
import { backfillReviewRounds } from '../review/review-outbox.ts'
import { reapStale } from '../run/run-liveness.ts'
import { terminalSharedGitConfigForRecordedRun } from '../run/shared-git-config-run.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'

let registered = false

const reapStaleRuns = (database: Parameters<typeof reapStale>[0]) =>
  reapStale(database, terminalSharedGitConfigForRecordedRun)

export function registerStandardHooks(): void {
  if (registered) return
  registerOpenHooks({
    afterWritableOpen: [ensureMachineIdentity, excludeSharedOutputRuns, reapStaleRuns],
    afterInitialize: [
      ensureMachineIdentity,
      excludeSharedOutputRuns,
      backfillReviewRounds,
      seedLenses,
      seedWorkflows,
    ],
  })
  registered = true
}
