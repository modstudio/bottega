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
  | {
      action: 'attach-recorded'
      branch: string
      tip: string | null
      tipSource: ResumeTipSource
      rootId: number
    }
  | {
      action: 'recreate-on-branch' | 'recreate-then-restore'
      branch: string
      existingBranch: string
      tip: string
      tipSource: Exclude<ResumeTipSource, null>
      rootId: number
    }
  | { action: 'refuse'; branch: string; tip: null; tipSource: null; rootId: number }

type ResumeTipSource = 'branch ref' | 'retained ref' | 'recorded close-out tip' | null

export type ContinuationBranchPlan = {
  branch: string | null
  tip: string | null
  source: 'latest turn branch' | 'root retained branch' | 'latest recorded branch' | 'none'
}

export type ResumeCreationLifecycle = 'command-template' | 'recipe' | 'built-in-git'

export type ResumeCreationOptions = {
  baseRef: string | undefined
  existingBranch: string | undefined
  existingBranchTip: string | undefined
  useCreateTool: boolean
}

/** Keep command-owned branch creation; recipes and Git recreate the conversation branch. */
export function resumeCreationOptions(
  plan:
    | Extract<ResumeTreePlan, { action: 'recreate-on-branch' | 'recreate-then-restore' }>
    | undefined,
  lifecycle: ResumeCreationLifecycle,
): ResumeCreationOptions {
  if (!plan)
    return {
      baseRef: undefined,
      existingBranch: undefined,
      existingBranchTip: undefined,
      useCreateTool: lifecycle !== 'built-in-git',
    }
  if (lifecycle === 'command-template') {
    return {
      baseRef: plan.tip,
      existingBranch: undefined,
      existingBranchTip: undefined,
      useCreateTool: true,
    }
  }
  return {
    baseRef: undefined,
    existingBranch: plan.existingBranch,
    existingBranchTip: plan.tip,
    useCreateTool: lifecycle === 'recipe',
  }
}

/** Prefer the latest turn's live branch, then preserve the prior fallback order. */
export function continuationBranchPlan(input: {
  latestBranch: string | null
  latestBranchTip: string | null
  rootBranch: string | null
}): ContinuationBranchPlan {
  if (input.latestBranch && input.latestBranchTip) {
    return {
      branch: input.latestBranch,
      tip: input.latestBranchTip,
      source: 'latest turn branch',
    }
  }
  if (input.rootBranch)
    return { branch: input.rootBranch, tip: null, source: 'root retained branch' }
  if (input.latestBranch)
    return { branch: input.latestBranch, tip: null, source: 'latest recorded branch' }
  return { branch: null, tip: null, source: 'none' }
}

/** Select the recoverable tip in descending order of authority. */
export function resumeTreePlan(facts: ResumeTreeFacts): ResumeTreePlan {
  const tip = facts.branchTip ?? facts.retainedTip ?? facts.recordedTip
  const tipSource: ResumeTipSource = facts.branchTip
    ? 'branch ref'
    : facts.retainedTip
      ? 'retained ref'
      : facts.recordedTip
        ? 'recorded close-out tip'
        : null
  if (facts.recordedTreeMatches) {
    return {
      action: 'attach-recorded',
      branch: facts.branch,
      tip,
      tipSource,
      rootId: facts.rootId,
    }
  }
  if (!tip || !tipSource)
    return {
      action: 'refuse',
      branch: facts.branch,
      tip: null,
      tipSource: null,
      rootId: facts.rootId,
    }
  return {
    action: facts.hasCreate ? 'recreate-then-restore' : 'recreate-on-branch',
    branch: facts.branch,
    existingBranch: facts.branch,
    tip,
    tipSource,
    rootId: facts.rootId,
  }
}
