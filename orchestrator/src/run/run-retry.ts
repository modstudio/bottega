// concern: run-retry
/** Decides retry conversation/tree reuse and renders the previous-attempt handoff. */

export type RetryBranchTipRelation = 'missing' | 'recorded' | 'descendant' | 'diverged'

export type RetryConversationDecision =
  | { action: 'regular-retry' }
  | { action: 'continue' }
  | { action: 'needs-writing-workspace' }

export type RetryPathDecision =
  | { action: 'regular-retry' }
  | { action: 'continue' }
  | { action: 'reuse-tree' }
  | { action: 'open-tree' }
  | { action: 'refuse-live-owner' }
  | { action: 'refuse-branch'; relation: 'missing' | 'diverged' }

export function decideRetryConversation(input: {
  writesRepo: boolean
  rulingsPresent: boolean
  agentChanged: boolean
}): RetryConversationDecision {
  if (!input.writesRepo) return { action: 'regular-retry' }
  if (!input.rulingsPresent && !input.agentChanged) return { action: 'continue' }
  return { action: 'needs-writing-workspace' }
}

export function decideWritingRetryWorkspace(input: {
  treeExists: boolean
  treeLive: boolean
  branchTipRelation: RetryBranchTipRelation
}): RetryPathDecision {
  if (input.branchTipRelation === 'missing') {
    return { action: 'refuse-branch', relation: 'missing' }
  }
  if (input.branchTipRelation === 'diverged') {
    return { action: 'refuse-branch', relation: 'diverged' }
  }
  if (input.treeLive) return { action: 'refuse-live-owner' }
  return input.treeExists ? { action: 'reuse-tree' } : { action: 'open-tree' }
}

export type AtomicRetryReuseDecision = { action: 'reuse' } | { action: 'refuse'; reason: string }

export type ContinuationInstruction = {
  turnId: number
  at: string
  instructions: string
}

/** Pure post-lock decision: all facts must still describe the validated retained tree. */
export function atomicRetryReuseDecision(input: {
  pathExists: boolean
  actualBranch: string | null
  expectedBranch: string
  actualHead: string | null
  validatedTip: string
}): AtomicRetryReuseDecision {
  if (!input.pathExists) return { action: 'refuse', reason: 'worktree path no longer exists' }
  if (input.actualBranch !== input.expectedBranch)
    return {
      action: 'refuse',
      reason: `worktree moved from branch ${input.expectedBranch} to ${input.actualBranch ?? '(detached)'}`,
    }
  if (input.actualHead !== input.validatedTip)
    return {
      action: 'refuse',
      reason: `worktree HEAD moved from ${input.validatedTip} to ${input.actualHead ?? '(unresolved)'}`,
    }
  return { action: 'reuse' }
}

export function renderWritingRetryPrompt(input: {
  originalSpec: string
  continuationInstructions: ContinuationInstruction[]
  rulings: string | null
  commit: string
  taskPointer: string | null
}): string {
  const continuationInstructions = input.continuationInstructions.length
    ? [
        'INSTRUCTIONS GIVEN SINCE THE ORIGINAL SPEC',
        '',
        ...input.continuationInstructions.flatMap((instruction, index) => [
          ...(index ? [''] : []),
          `Turn ${instruction.turnId} at ${instruction.at}:`,
          instruction.instructions,
        ]),
      ].join('\n')
    : null
  const previousAttempt = [
    'PREVIOUS ATTEMPT',
    '',
    `This worktree already holds a previous attempt's work at ${input.commit}.`,
    input.taskPointer ? `Last completed item: ${input.taskPointer}` : null,
    'Continue from there rather than restart.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  return [input.originalSpec, continuationInstructions, input.rulings, previousAttempt]
    .filter((section): section is string => Boolean(section))
    .join('\n\n---\n\n')
}

export function previousAttemptTaskPointer(input: {
  checkpoint: string | null
  latestScratch: string | null
  rootScratch: string | null
}): string | null {
  return input.checkpoint ?? input.latestScratch ?? input.rootScratch
}
