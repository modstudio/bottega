// concern: workflow repin decision
/** Decides whether an open cursor may adopt the current workflow and catalogue versions. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isClosedStep, type CursorTrailEntry } from './workflow-cursor-trail.ts'

export type RepinStep = { slug: string; floors: readonly string[] }

export type WorkflowRepinDecision =
  | { action: 'allow' }
  | { action: 'refuse'; message: string }

export function decideWorkflowRepin(input: {
  cursor: number
  oldSteps: readonly RepinStep[]
  newSteps: readonly RepinStep[]
  currentOrdinal: number
  trail: readonly CursorTrailEntry[]
  holderSession: string | null
  callerSession: string | null
  callerIsOperator: boolean
  pendingQuestion: boolean
  pendingAwait: boolean
  alreadyCurrent: boolean
}): WorkflowRepinDecision {
  const retry = `${PLATFORM_SLUG} workflow repin --cursor ${input.cursor} --reason <text>`
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
      message: `workflow cursor ${input.cursor} has a pending workflow await; answer it with \`${PLATFORM_SLUG} workflow rule\`, then retry ${retry}`,
    }
  if (input.pendingQuestion)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} has an open workflow question or ruling; answer it, then retry ${retry}`,
    }
  for (let ordinal = 0; ordinal <= input.currentOrdinal; ordinal += 1) {
    const oldSlug = input.oldSteps[ordinal]?.slug ?? '<missing>'
    const newSlug = input.newSteps[ordinal]?.slug ?? '<missing>'
    if (oldSlug !== newSlug)
      return {
        action: 'refuse',
        message: `workflow cursor ${input.cursor} step ${ordinal + 1} differs: pinned ${oldSlug}, current ${newSlug}; restore matching steps through the current ordinal or open a successor with \`${PLATFORM_SLUG} workflow handoff\``,
      }
  }
  const closedOrdinals = new Set(
    input.trail.filter(isClosedStep).map((entry) => entry.n - 1),
  )
  for (const ordinal of [...closedOrdinals].sort((a, b) => a - b)) {
    const oldStep = input.oldSteps[ordinal]
    const nextStep = input.newSteps[ordinal]
    if (!oldStep || !nextStep) continue
    const oldFloors = new Set(oldStep.floors)
    const added = nextStep.floors.find((floor) => !oldFloors.has(floor))
    if (added)
      return {
        action: 'refuse',
        message: `workflow cursor ${input.cursor} closed step ${ordinal + 1} ${oldStep.slug} adds floor ${added}; remove that added floor from the current catalogue or open a successor with \`${PLATFORM_SLUG} workflow handoff\``,
      }
  }
  if (input.alreadyCurrent)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} is already current; no repin was written`,
    }
  return { action: 'allow' }
}
