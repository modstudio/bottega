// concern: continuation-checkpoint-context
/** Connects a resolved continuation tree to checkpoint prompt provenance. */

import type { Database } from 'bun:sqlite'
import { checkpointResumeContext } from './checkpoint.ts'
import type { ResumeTreePlan } from './resume-tree.ts'
import { continuationHasCheckpoint } from './run-resume-kind.ts'

/** A tree plan that recreated the tree is a resume start with no checkpoint row. */
function synthesizedResumeContext(plan: ResumeTreePlan | null): string | null {
  if (!plan || plan.action === 'attach-recorded' || plan.action === 'refuse') return null
  return `CHECKPOINT RESUME\nResume from retained work at ${plan.tip}.`
}

/**
 * The block names the tree state to resume from, and a checkpoint row (or a
 * tree plan that recreated the tree) is what makes that state reconstructed
 * rather than continued; the caller needs both facts.
 */
export function continuationCheckpointContext(input: {
  database: Database
  rootId: string
  worktree: string | null
  treePlan: ResumeTreePlan | null
}): { context: string | null; hasCheckpoint: boolean } {
  const saved = checkpointResumeContext(
    input.database,
    input.rootId,
    input.worktree,
    input.treePlan?.tip ?? null,
    input.treePlan?.branch ?? null,
  )
  const synthesized = saved.context ? null : synthesizedResumeContext(input.treePlan)
  return {
    context: saved.context ?? synthesized,
    hasCheckpoint: continuationHasCheckpoint({
      hasCheckpointRow: saved.hasCheckpointRow,
      hasSynthesizedBlock: Boolean(synthesized),
    }),
  }
}
