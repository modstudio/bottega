// concern: workflow explore graduation
/** Decides whether a task-bound composition may close its session's untouched explore cursor. */

export type ExploreGraduationCandidate = {
  cursor: number
  recordId: string
  closedSteps: number
  hasOpenQuestion: boolean
  attachedText: number
}

export type ExploreGraduationDecision =
  | { action: 'close'; cursor: number; recordId: string }
  | { action: 'keep' }

export function exploreGraduation(input: {
  taskBound: boolean
  explore: ExploreGraduationCandidate | null
}): ExploreGraduationDecision {
  if (!input.taskBound || !input.explore) return { action: 'keep' }
  if (
    input.explore.closedSteps > 0 ||
    input.explore.hasOpenQuestion ||
    input.explore.attachedText > 0
  )
    return { action: 'keep' }
  return {
    action: 'close',
    cursor: input.explore.cursor,
    recordId: input.explore.recordId,
  }
}
