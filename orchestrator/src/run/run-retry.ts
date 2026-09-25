// concern: run-retry
/** Decides retry conversation/tree reuse and renders the previous-attempt handoff. */

import { pidAlive } from '../../../shared/process-identity.ts'

export type RetryBranchTipRelation = 'missing' | 'recorded' | 'descendant' | 'diverged'

export type RetryPathDecision =
  | { action: 'regular-retry' }
  | { action: 'continue' }
  | { action: 'reuse-tree' }
  | { action: 'open-tree' }
  | { action: 'refuse-live-owner' }
  | { action: 'refuse-branch'; relation: 'missing' | 'diverged' }

/** The same live-owner question used when deciding whether a ruling resumes in place. */
export function retryOwnerProcessAlive(owner: {
  owner_status: string
  owner_pid: number | null
}): boolean {
  return (
    (owner.owner_status === 'running' || owner.owner_status === 'asking') &&
    pidAlive(owner.owner_pid)
  )
}

export function decideRetryPath(input: {
  writesRepo: boolean
  rulingsPresent: boolean
  agentChanged: boolean
  treeExists: boolean
  treeLive: boolean
  branchTipRelation: RetryBranchTipRelation
}): RetryPathDecision {
  if (!input.writesRepo) return { action: 'regular-retry' }
  if (!input.rulingsPresent && !input.agentChanged) return { action: 'continue' }
  if (input.branchTipRelation === 'missing') {
    return { action: 'refuse-branch', relation: 'missing' }
  }
  if (input.branchTipRelation === 'diverged') {
    return { action: 'refuse-branch', relation: 'diverged' }
  }
  if (input.treeLive) return { action: 'refuse-live-owner' }
  return input.treeExists ? { action: 'reuse-tree' } : { action: 'open-tree' }
}

export function renderWritingRetryPrompt(input: {
  originalSpec: string
  rulings: string | null
  commit: string
  taskPointer: string | null
}): string {
  const previousAttempt = [
    'PREVIOUS ATTEMPT',
    '',
    `This worktree already holds a previous attempt's work at ${input.commit}.`,
    input.taskPointer ? `Last completed item: ${input.taskPointer}` : null,
    'Continue from there rather than restart.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
  return [input.originalSpec, input.rulings, previousAttempt]
    .filter((section): section is string => Boolean(section))
    .join('\n\n---\n\n')
}
