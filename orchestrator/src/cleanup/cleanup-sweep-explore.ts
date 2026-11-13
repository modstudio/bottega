// concern: cleanup sweep explores
/** Gathers keyless session cursors, applies their owner-gone ruling, and reports retained work. */

import type { Database } from 'bun:sqlite'
import { db, writableDb } from '../database/db.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { closeExploreForLifecycle } from '../workflow/workflow-explore-lifecycle-close.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { UNJUDGED_OWNER_WINDOW_MS } from './cleanup-sweep-decisions.ts'
import { decideSessionCursorSweep } from './cleanup-sweep-explore-decision.ts'
import { gatherOwnerActivity } from './owner-activity.ts'

export async function sweepSessionCursors(input: {
  dryRun: boolean
  project: string | null
  presentation: CleanupPresentation
  database?: Database
  now?: number
}): Promise<boolean> {
  const database = input.database ?? (input.dryRun ? db() : writableDb())
  let failed = false
  for (const cursor of await taskFlowReadStore(database).keylessSessionCursors(input.project)) {
    const activity = gatherOwnerActivity(database, {
      ownerSessionId: cursor.session_id,
      holderActivityAt: cursor.updated_at,
    })
    const decision = decideSessionCursorSweep({
      ...activity,
      cursor: cursor.number,
      workflowSlug: cursor.workflow_slug,
      stepSlug: cursor.step_slug,
      openQuestionRecordId: cursor.open_question_record_id,
      now: input.now ?? Date.now(),
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
    })
    if (decision.action === 'keep') continue
    if (decision.action === 'report') {
      input.presentation.log(`kept ${decision.item}; remedy: ${decision.remedy}`)
      continue
    }
    if (input.dryRun) {
      input.presentation.log(`would expire workflow cursor ${cursor.number} (explore)`)
      continue
    }
    try {
      await closeExploreForLifecycle(cursor.record_id, 'expired', database)
      input.presentation.log(`expired workflow cursor ${cursor.number} (explore)`)
    } catch (cause) {
      failed = true
      input.presentation.error(
        `could not expire workflow cursor ${cursor.number} (explore): ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
  return failed
}
