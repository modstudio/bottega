// concern: workflows
/** Decides whether mutable recorded evidence changed during the active workflow step. */

import { createdAfterStepActivation } from './workflow-cursor-trail.ts'

export type MutableArtifactKind =
  | 'doc'
  | 'task'
  | 'task comment'
  | 'task document'
  | 'note'
  | 'attached text'

function mutableArtifactFreshnessRefusal(
  kind: MutableArtifactKind,
  writtenAt: string | null | undefined,
  stepActivatedAt: string,
): string | null {
  if (writtenAt && createdAfterStepActivation(writtenAt, stepActivatedAt)) return null
  return `${kind} record time is ${writtenAt ?? 'unavailable'}, before step activation ${stepActivatedAt}; write or change the ${kind} record during this step, then cite it`
}

export function requireMutableArtifactFreshness(
  kind: MutableArtifactKind,
  writtenAt: string | null | undefined,
  stepActivatedAt: string,
): void {
  const refusal = mutableArtifactFreshnessRefusal(kind, writtenAt, stepActivatedAt)
  if (refusal) throw new Error(refusal)
}

export type TimedArtifactNotice = { kind: MutableArtifactKind; untimed: string }

export const TASK_FRESHNESS_NOTICE: TimedArtifactNotice = {
  kind: 'task',
  untimed: 'freshness unchecked: the tracker returns no task update time',
}

export const TASK_COMMENT_FRESHNESS_NOTICE: TimedArtifactNotice = {
  kind: 'task comment',
  untimed: 'freshness unchecked: external tracker returns no comment time',
}

export function timedArtifactFreshnessNotice(
  config: TimedArtifactNotice,
  writtenAt: string | null | undefined,
  stepActivatedAt: string,
): string | null {
  if (writtenAt) requireMutableArtifactFreshness(config.kind, writtenAt, stepActivatedAt)
  return writtenAt ? null : config.untimed
}

export const TIMED_FRESHNESS = {
  task: TASK_FRESHNESS_NOTICE,
  taskComment: TASK_COMMENT_FRESHNESS_NOTICE,
  notice: timedArtifactFreshnessNotice,
}

export function requireAttachedTextFreshness(
  attachment: { writtenAt?: string } | null,
  stepActivatedAt: string,
): void {
  if (attachment)
    requireMutableArtifactFreshness('attached text', attachment.writtenAt, stepActivatedAt)
}
