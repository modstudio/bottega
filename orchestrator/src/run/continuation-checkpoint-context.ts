// concern: continuation-checkpoint-context
/** Connects a resolved continuation tree to checkpoint prompt provenance. */

import type { Database } from 'bun:sqlite'
import { checkpointResumeContext } from './checkpoint.ts'
import type { ResumeTreePlan } from './resume-tree.ts'

export function continuationCheckpointContext(input: {
  database: Database
  rootId: number
  worktree: string | null
  treePlan: ResumeTreePlan | null
}): string | null {
  return checkpointResumeContext(
    input.database,
    input.rootId,
    input.worktree,
    input.treePlan?.tip ?? null,
    input.treePlan?.branch ?? null,
  )
}
