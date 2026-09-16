// concern: adopted worktree close-out decision
/** Decides whether an attached tree can be released without taking it from a live run. */

import type { TreeOwnership } from './worktree-attribution.ts'

export type AdoptedTreeCloseOutDecision = 'ordinary' | 'release-adopted' | 'forgotten' | 'held'

export function adoptedTreeCloseOutDecision(input: {
  ownership: TreeOwnership
  ownerAlive: boolean
  sharerAlive: boolean
}): AdoptedTreeCloseOutDecision {
  if (input.ownership === 'owned') return 'ordinary'
  if (input.ownership === 'unknown') return 'held'
  return input.ownerAlive || input.sharerAlive ? 'forgotten' : 'release-adopted'
}
