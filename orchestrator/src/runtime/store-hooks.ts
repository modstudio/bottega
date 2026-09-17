// concern: store-hooks
/** Knows which database lifecycle hooks provide evidence hygiene, run liveness, and workflow seeds. Must not know CLI commands, run execution, transports, routing, or worktrees. */
import { registerOpenHooks } from '../database/db.ts'
import { excludeSharedOutputRuns } from '../evidence/evidence-query.ts'
import { reapStale } from '../run/run-liveness.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'

let registered = false

export function registerStandardHooks(): void {
  if (registered) return
  registerOpenHooks({
    afterWritableOpen: [excludeSharedOutputRuns, reapStale],
    afterInitialize: [excludeSharedOutputRuns, seedWorkflows],
    afterSchemaApply: [seedWorkflows],
  })
  registered = true
}
