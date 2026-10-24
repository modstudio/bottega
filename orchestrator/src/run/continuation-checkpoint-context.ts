// concern: continuation-checkpoint-context
/** Connects a resolved continuation tree to checkpoint prompt provenance. */

import type { Database } from 'bun:sqlite'
import { checkpointResumeContext } from './checkpoint.ts'
import type { ResumeTreePlan } from './resume-tree.ts'
import { continuationHasCheckpoint } from './run-resume-kind.ts'

/**
 * A plan that recreates the tree runs the turn somewhere else: neither the
 * checkpoint row nor an operation in the recorded tree describes that tree, so
 * both the synthesized block and the operation line say so.
 */
function recreatesTree(plan: ResumeTreePlan | null): boolean {
  return Boolean(plan && plan.action !== 'attach-recorded' && plan.action !== 'refuse')
}

/** A tree plan that recreated the tree is a resume start with no checkpoint row. */
function synthesizedResumeContext(plan: ResumeTreePlan | null): string | null {
  if (!plan || !recreatesTree(plan)) return null
  return `CHECKPOINT RESUME\nResume from retained work at ${plan.tip}.`
}

/** What the continuation prompt needs to know about checkpoint reconstruction. */
export type ContinuationCheckpointContext = {
  context: string | null
  hasCheckpoint: boolean
  hasCheckpointRow: boolean
}

/**
 * The block names the tree state to resume from, and a checkpoint row (or a
 * tree plan that recreated the tree) is what makes that state reconstructed
 * rather than continued; the caller needs both facts.
 *
 * `hasCheckpointRow` stays separate from `hasCheckpoint` because only a row
 * makes the original spec the prompt's subject: without one the conversation
 * continues, so a block is context carried in front of the continuation message
 * rather than a reason to demand the reaped original prompt file.
 */
export function continuationCheckpointContext(input: {
  database: Database
  rootId: string
  worktree: string | null
  treePlan: ResumeTreePlan | null
}): ContinuationCheckpointContext {
  const saved = checkpointResumeContext({
    database: input.database,
    rootId: input.rootId,
    worktree: input.worktree,
    runsInRecordedTree: !recreatesTree(input.treePlan),
    startCommit: input.treePlan?.tip ?? null,
    branch: input.treePlan?.branch ?? null,
  })
  const synthesized = saved.context ? null : synthesizedResumeContext(input.treePlan)
  return {
    context: saved.context ?? synthesized,
    hasCheckpoint: continuationHasCheckpoint({
      hasCheckpointRow: saved.hasCheckpointRow,
      hasSynthesizedBlock: Boolean(synthesized),
    }),
    hasCheckpointRow: saved.hasCheckpointRow,
  }
}
