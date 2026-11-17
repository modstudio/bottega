// concern: cleanup sweep explore decision
/** Decides whether a gone session's keyless cursor expires or remains visible for intervention. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { workflowCursorReference } from '../workflow/workflow-cursor-format.ts'
import { ownerIsGone, type UnjudgedOwnerFacts } from './cleanup-sweep-decisions.ts'

export type SessionCursorSweepFacts = UnjudgedOwnerFacts & {
  cursor: number
  project: string
  workflowSlug: string
  stepSlug: string
  openQuestionRecordId: string | null
}

export type SessionCursorSweepDecision =
  | { action: 'keep' }
  | { action: 'expire' }
  | { action: 'report'; item: string; remedy: string }

export function decideSessionCursorSweep(
  facts: SessionCursorSweepFacts,
): SessionCursorSweepDecision {
  if (!ownerIsGone(facts)) return { action: 'keep' }
  const reference = workflowCursorReference(facts.cursor, facts.project).cli
  const adopt = `${PLATFORM_SLUG} workflow step ${facts.workflowSlug} ${facts.stepSlug}${reference}`
  const owner = facts.ownerSessionId ? ` --owner-session ${facts.ownerSessionId}` : ''
  const abandon = `${PLATFORM_SLUG} workflow abandon ${facts.workflowSlug}${reference} --reason "<why>"${owner}`
  if (facts.openQuestionRecordId)
    return {
      action: 'report',
      item: `workflow question ${facts.openQuestionRecordId} on cursor ${facts.cursor}`,
      remedy: `${adopt} to adopt the cursor, or ${abandon}`,
    }
  if (facts.workflowSlug === 'explore') return { action: 'expire' }
  return {
    action: 'report',
    item: `workflow cursor ${facts.cursor} (${facts.workflowSlug})`,
    remedy: `${adopt} to adopt the cursor, or ${abandon}`,
  }
}
