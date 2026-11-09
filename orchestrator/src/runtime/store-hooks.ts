// concern: store-hooks
/** Knows which database lifecycle hooks provide evidence hygiene, review-round backfill, run liveness, and workflow seeds. Must not know CLI commands, run execution, transports, routing, or worktrees. */
import { HOSTED_TABLES_WITHOUT_LOCAL_ACCESS } from '../../../shared/hosted-tables.ts'
import { ensureMachineIdentity, type OpenHooks, registerOpenHooks } from '../database/db.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { excludeSharedOutputRuns } from '../evidence/evidence-query.ts'
import { seedLenses } from '../lens/lens-seeds.ts'
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { backfillReviewRounds } from '../review/review-round-backfill.ts'
import { reapStale } from '../run/run-liveness.ts'
import { terminalSharedGitConfigForRecordedRun } from '../run/shared-git-config-run.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'

let registered = false

const reapStaleRuns = (database: Parameters<typeof reapStale>[0]) =>
  reapStale(database, terminalSharedGitConfigForRecordedRun)

export function shouldGuardHostedTables(
  verdict: 'hosted' | 'local-authoritative' | 'refused',
  tables: readonly string[],
): boolean {
  return verdict === 'hosted' && tables.length > 0
}

const accessedHandles = new WeakMap<
  Parameters<NonNullable<OpenHooks['access']>>[0],
  ReturnType<NonNullable<OpenHooks['access']>>
>()

function standardStoreAccess(database: Parameters<NonNullable<OpenHooks['access']>>[0]) {
  const cached = accessedHandles.get(database)
  if (cached) return cached
  const accessed = shouldGuardHostedTables(
    currentRecordWriteDecision(database).verdict,
    HOSTED_TABLES_WITHOUT_LOCAL_ACCESS,
  )
    ? guardHostedTables(database)
    : database
  accessedHandles.set(database, accessed)
  return accessed
}

/** The standard lifecycle composition, exported so diagnostics replay the production hooks. */
export const STANDARD_OPEN_HOOKS: OpenHooks = {
  ...(HOSTED_TABLES_WITHOUT_LOCAL_ACCESS.length > 0 ? { access: standardStoreAccess } : {}),
  // Shared-output exclusion is a backfill: run-keyed output names cannot collide, and its
  // two whole-table scans would otherwise run on every writable open.
  afterWritableOpen: [ensureMachineIdentity, reapStaleRuns],
  afterInitialize: [
    ensureMachineIdentity,
    excludeSharedOutputRuns,
    backfillReviewRounds,
    seedLenses,
    seedWorkflows,
  ],
}

export function registerStandardHooks(): void {
  if (registered) return
  registerOpenHooks(STANDARD_OPEN_HOOKS)
  registered = true
}
