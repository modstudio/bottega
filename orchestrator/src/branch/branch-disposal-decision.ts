// concern: branch disposal
/** Pure eligibility ruling for reversible disposal of unique, unproved branch work. */

import { type StatusCategory, TASK_STATUSES } from '../../../shared/trackers.ts'
import type { TaskStatusObservation } from './task-status-observation.ts'

export const BRANCH_DISPOSAL_REASONS = ['abandoned', 'superseded', 'throwaway'] as const
export type BranchDisposalReason = (typeof BRANCH_DISPOSAL_REASONS)[number]

export type BranchDisposalDecision =
  | { eligible: true }
  | {
      eligible: false
      reason:
        | 'missing-ref'
        | 'not-run-minted'
        | 'live-owner'
        | 'open-task'
        | 'proved-safe'
        | 'superseded-target-missing'
    }

export function disposalTaskState(observation: TaskStatusObservation): 'open' | 'closed' {
  if (
    !observation.verified ||
    observation.category === null ||
    !TASK_STATUSES.includes(observation.category as StatusCategory)
  )
    return 'open'
  return observation.category === 'done' || observation.category === 'dropped' ? 'closed' : 'open'
}

export function decideBranchDisposal(input: {
  runMinted: boolean
  refExists: boolean
  liveRun: boolean
  checkedOut: boolean
  taskStatus: string
  uniqueWork: boolean
  operator: boolean
  supersededTargetNamed: boolean
}): BranchDisposalDecision {
  if (!input.refExists) return { eligible: false, reason: 'missing-ref' }
  if (!input.runMinted) return { eligible: false, reason: 'not-run-minted' }
  if (input.liveRun || input.checkedOut) return { eligible: false, reason: 'live-owner' }
  if (!input.uniqueWork) return { eligible: false, reason: 'proved-safe' }
  if (!input.supersededTargetNamed) return { eligible: false, reason: 'superseded-target-missing' }
  if (input.taskStatus === 'open' && !input.operator)
    return { eligible: false, reason: 'open-task' }
  return { eligible: true }
}
