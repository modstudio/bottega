// concern: workflow compose claim rollback
/** Restores claim ownership when a cursor compose fails after taking the task claim. */

import type { Database } from 'bun:sqlite'
import type { CursorStartDecision } from './workflow-cursor-transition.ts'
import { followTaskCursorClaim, taskClaimReleaseWarning } from './workflow-task-claim.ts'

export async function rollbackComposeClaim(input: {
  claimAction: 'taken' | 'renewed' | 'taken-over' | undefined
  start: CursorStartDecision
  project: string
  taskKey: string | null
  session: string | null | undefined
  displacedSession: string | null
  database: Database
  error: unknown
}): Promise<never> {
  const shouldRelease =
    input.claimAction === 'taken-over' || (input.start !== 'reuse' && input.claimAction === 'taken')
  let releaseWarning: string | null = null
  if (shouldRelease) {
    try {
      await followTaskCursorClaim({
        project: input.project,
        taskKey: input.taskKey,
        session: input.session,
        verb: 'abandon',
        database: input.database,
      })
    } catch (error) {
      if (input.taskKey)
        releaseWarning = taskClaimReleaseWarning(input.project, input.taskKey, error)
    }
  }
  const detail = input.error instanceof Error ? input.error.message : String(input.error)
  const takeoverWarning =
    input.claimAction === 'taken-over'
      ? `warning: claim taken from session ${input.displacedSession ?? 'unknown'} was released after compose failed; that session can retake it with workflow compose`
      : null
  throw new Error([detail, releaseWarning, takeoverWarning].filter(Boolean).join('\n'), {
    cause: input.error,
  })
}
