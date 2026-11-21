// concern: workflows
/** Decides whether mutable recorded evidence changed during the active workflow step. */

import { createdAfterStepActivation } from './workflow-cursor-trail.ts'

export function mutableArtifactFreshnessRefusal(
  kind: string,
  writtenAt: string | null | undefined,
  stepActivatedAt: string,
): string | null {
  if (writtenAt && createdAfterStepActivation(writtenAt, stepActivatedAt)) return null
  return `${kind} record time is ${writtenAt ?? 'unavailable'}, before step activation ${stepActivatedAt}; write or change the ${kind} record during this step, then cite it`
}

export function requireMutableArtifactFreshness(
  kind: string,
  writtenAt: string | null | undefined,
  stepActivatedAt: string,
): void {
  const refusal = mutableArtifactFreshnessRefusal(kind, writtenAt, stepActivatedAt)
  if (refusal) throw new Error(refusal)
}

export function timedTaskCommentFreshnessNotice(
  writtenAt: string | undefined,
  stepActivatedAt: string,
): string | null {
  // External trackers expose comment ids without timestamps, so only timed comments get freshness.
  if (writtenAt) requireMutableArtifactFreshness('task comment', writtenAt, stepActivatedAt)
  return writtenAt ? null : 'freshness unchecked: external tracker returns no comment time'
}

export function requireAttachedTextFreshness(
  attachment: { writtenAt?: string } | null,
  stepActivatedAt: string,
): void {
  if (attachment)
    requireMutableArtifactFreshness('attached text', attachment.writtenAt, stepActivatedAt)
}
