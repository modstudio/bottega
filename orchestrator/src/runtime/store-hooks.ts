// concern: store-hooks
/** Knows which database lifecycle hooks provide evidence hygiene, run liveness, and workflow seeds. Must not know CLI commands, run execution, transports, routing, or worktrees. */
import type { Database } from 'bun:sqlite'
import { ensureMachineIdentity, registerOpenHooks, writeTransaction } from '../database/db.ts'
import { excludeSharedOutputRuns } from '../evidence/evidence-query.ts'
import { seedLenses } from '../lens/lens-seeds.ts'
import { reviewRunEvidenceSql } from '../review/review-evidence-sql.ts'
import { enqueueChangedReviewRounds } from '../review/review-outbox.ts'
import {
  reviewRoundForRecording,
  reviewRoundIdentity,
} from '../review/review-round-identity.ts'
import { reapStale } from '../run/run-liveness.ts'
import { terminalSharedGitConfigForRecordedRun } from '../run/shared-git-config-run.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'

let registered = false

const reapStaleRuns = (database: Parameters<typeof reapStale>[0]) =>
  reapStale(database, terminalSharedGitConfigForRecordedRun)

type PendingReviewRound = {
  record_id: string
  project: string
  role: 'round'
  patch_id: string | null
  path_set: string | null
  launch_key: string | null
  branch: string
}

/** Fill historical ordinals through the same classification and lineage rule used at write time. */
export function backfillReviewRounds(database: Database): number {
  const pending = database
    .query<PendingReviewRound, []>(
      `SELECT r.record_id,p.name AS project,r.role,r.patch_id,r.path_set,run.launch_key,run.branch
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
         JOIN project p ON p.record_id=run.project_record_id
        WHERE r.role='round' AND r.round IS NULL AND run.branch IS NOT NULL
          AND ${reviewRunEvidenceSql('run', 'rl')}
        ORDER BY r.recorded_at,r.number,run.number,rl.record_id`,
    )
    .all()
  const seen = new Set<string>()
  const classifiable = pending.filter((row) => {
    if (seen.has(row.record_id)) return false
    seen.add(row.record_id)
    return reviewRoundIdentity(row).identity !== null
  })
  if (!classifiable.length) return 0

  return writeTransaction(() => {
    let changed = 0
    for (const row of classifiable) {
      const round = reviewRoundForRecording(database, row)
      if (round === null) continue
      const result = database
        .query('UPDATE review SET round=? WHERE record_id=? AND round IS NULL')
        .run(round, row.record_id)
      changed += result.changes
    }
    enqueueChangedReviewRounds(database)
    return changed
  }, database)
}

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
