// concern: workflow repin decision
/** Decides whether an open cursor may adopt the current workflow and catalogue versions. */

export type RepinStep = { slug: string }
export type RepinClosedStep = {
  ordinal: number
  slug: string
  outcome?: string
  oldFloors: readonly string[]
  newFloors: readonly string[]
}

export type WorkflowRepinDecision = { action: 'allow' } | { action: 'refuse'; message: string }

export function decideWorkflowRepin(input: {
  cursor: number
  oldSteps: readonly RepinStep[]
  newSteps: readonly RepinStep[]
  currentOrdinal: number
  closedSteps: readonly RepinClosedStep[]
  holderSession: string | null
  callerSession: string | null
  callerIsOperator: boolean
  pendingQuestion: boolean
  pendingAwait: boolean
  alreadyCurrent: boolean
  retryCommand: string
}): WorkflowRepinDecision {
  if (
    !input.callerIsOperator &&
    (!input.callerSession || input.callerSession !== input.holderSession)
  )
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} is held by session ${input.holderSession ?? 'none'}; retry from the holding session or ask the operator to repin it`,
    }
  if (input.pendingAwait)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} has a pending workflow await; answer it with the workflow rule verb, then retry ${input.retryCommand}`,
    }
  if (input.pendingQuestion)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} has an open workflow question or ruling; answer it, then retry ${input.retryCommand}`,
    }
  for (let ordinal = 0; ordinal <= input.currentOrdinal; ordinal += 1) {
    const oldSlug = input.oldSteps[ordinal]?.slug ?? '<missing>'
    const newSlug = input.newSteps[ordinal]?.slug ?? '<missing>'
    if (oldSlug !== newSlug)
      return {
        action: 'refuse',
        message: `workflow cursor ${input.cursor} step ${ordinal + 1} differs: pinned ${oldSlug}, current ${newSlug}; restore matching steps through the current ordinal or open a successor with the workflow handoff verb`,
      }
  }
  for (const step of [...input.closedSteps].sort((a, b) => a.ordinal - b.ordinal)) {
    const oldFloors = new Set(step.oldFloors)
    const added = step.newFloors.find((floor) => !oldFloors.has(floor))
    if (added)
      return {
        action: 'refuse',
        message: `workflow cursor ${input.cursor} closed step ${step.ordinal} ${step.slug}${step.outcome ? ` outcome ${step.outcome}` : ''} adds floor ${added}; remove that added floor from the current catalogue or open a successor with the workflow handoff verb`,
      }
  }
  if (input.alreadyCurrent)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} is already current; no repin was written`,
    }
  return { action: 'allow' }
}
