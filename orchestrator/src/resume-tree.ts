// concern: resume-tree
/**
 * Decides whether continuation can reuse or must rebuild its repository tree.
 * Knows only observed tree and ref facts. Must not read Git, run rows, or project settings.
 */

export type ResumeTreeFacts = {
  rootId: number
  branch: string
  recordedTreeMatches: boolean
  hasCreate: boolean
  branchTip: string | null
  retainedTip: string | null
  recordedTip: string | null
}

export type ResumeTreePlan =
  | { action: 'attach-recorded'; branch: string; tip: string | null; rootId: number }
  | { action: 'recreate-on-branch'; branch: string; tip: string; rootId: number }
  | { action: 'recreate-then-restore'; branch: string; tip: string; rootId: number }
  | { action: 'refuse'; branch: string; tip: null; rootId: number }

/** Select the recoverable tip in descending order of authority. */
export function resumeTreePlan(facts: ResumeTreeFacts): ResumeTreePlan {
  const tip = facts.branchTip ?? facts.retainedTip ?? facts.recordedTip
  if (facts.recordedTreeMatches) {
    return { action: 'attach-recorded', branch: facts.branch, tip, rootId: facts.rootId }
  }
  if (!tip) return { action: 'refuse', branch: facts.branch, tip: null, rootId: facts.rootId }
  return {
    action: facts.hasCreate ? 'recreate-then-restore' : 'recreate-on-branch',
    branch: facts.branch,
    tip,
    rootId: facts.rootId,
  }
}
