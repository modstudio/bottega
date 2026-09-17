// concern: adopted worktree close-out decision
/** Decides whether a tree belongs to this run's automatic teardown. */

import type { TreeOwnership } from '../worktree-attribution.ts'

export type AdoptedTreeCloseOutDecision = 'ordinary' | 'forgotten' | 'held'

export function adoptedTreeCloseOutDecision(ownership: TreeOwnership): AdoptedTreeCloseOutDecision {
  if (ownership === 'owned') return 'ordinary'
  if (ownership === 'unknown') return 'held'
  return 'forgotten'
}
