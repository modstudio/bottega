// concern: workflow repin decision
/** Decides whether an open cursor may adopt the current workflow and catalogue versions. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type RepinStep = { slug: string }
type RepinFloor = {
  kind: string
  deferrable: boolean
  expectedExitCode: number
  expectedStatus: string
  requirePullRequest: boolean
  operatorRuling: boolean
  commandEvidence?: string
}
export type RepinClosedStep = {
  ordinal: number
  slug: string
  outcome?: string
  oldFloors: readonly RepinFloor[]
  newFloors: readonly RepinFloor[]
}

export type WorkflowRepinDecision = { action: 'allow' } | { action: 'refuse'; message: string }

export type RepinWriteFacts = {
  sessionId: string | null
  state: string
  activeOrdinal: number
  workflowVersionId: string
  catalogueVersionId: string
  hasOpenWorkflowQuestion: boolean
}

/** Re-checks the cursor facts consumed by the client decision immediately before its write. */
export function repinWriteRefusal(
  cursor: number | string,
  current: RepinWriteFacts,
  expected: Omit<RepinWriteFacts, 'hasOpenWorkflowQuestion'>,
): string | undefined {
  const retry = `rerun ${PLATFORM_SLUG} workflow repin`
  if (current.state === 'awaiting-ruling')
    return `workflow cursor ${cursor} gained a pending workflow await; ${retry}`
  if (current.hasOpenWorkflowQuestion)
    return `workflow cursor ${cursor} gained an open workflow question; ${retry}`
  if (current.sessionId !== expected.sessionId)
    return `workflow cursor ${cursor} holder changed from ${expected.sessionId ?? 'none'} to ${current.sessionId ?? 'none'}; ${retry}`
  if (current.state !== expected.state)
    return `workflow cursor ${cursor} state changed from ${expected.state} to ${current.state}; ${retry}`
  if (current.activeOrdinal !== expected.activeOrdinal)
    return `workflow cursor ${cursor} ordinal changed from ${expected.activeOrdinal + 1} to ${current.activeOrdinal + 1}; ${retry}`
  if (current.workflowVersionId !== expected.workflowVersionId)
    return `workflow cursor ${cursor} pinned workflow version changed; ${retry}`
  if (current.catalogueVersionId !== expected.catalogueVersionId)
    return `workflow cursor ${cursor} pinned catalogue version changed; ${retry}`
  return undefined
}

function sameFloor(left: RepinFloor, right: RepinFloor): boolean {
  return (
    left.kind === right.kind &&
    left.deferrable === right.deferrable &&
    left.expectedExitCode === right.expectedExitCode &&
    left.expectedStatus === right.expectedStatus &&
    left.requirePullRequest === right.requirePullRequest &&
    left.operatorRuling === right.operatorRuling &&
    left.commandEvidence === right.commandEvidence
  )
}

function changedFloorAttribute(oldFloor: RepinFloor, newFloor: RepinFloor): string | undefined {
  const attributes = [
    'deferrable',
    'expectedExitCode',
    'expectedStatus',
    'requirePullRequest',
    'operatorRuling',
    'commandEvidence',
  ] as const
  return attributes.find((attribute) => oldFloor[attribute] !== newFloor[attribute])
}

function incompatibleFloorRefusal(cursor: number, step: RepinClosedStep): string | undefined {
  const added = step.newFloors.find(
    (newFloor) => !step.oldFloors.some((oldFloor) => sameFloor(oldFloor, newFloor)),
  )
  if (!added) return undefined
  const oldKind = step.oldFloors.find((floor) => floor.kind === added.kind)
  const difference = oldKind ? ` differs in ${changedFloorAttribute(oldKind, added)}` : ' added'
  return `workflow cursor ${cursor} closed step ${step.ordinal} ${step.slug}${step.outcome ? ` outcome ${step.outcome}` : ''} floor ${added.kind}${difference}; restore the old floor definition in the current catalogue or open a successor with the workflow handoff verb`
}

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
    const refusal = incompatibleFloorRefusal(input.cursor, step)
    if (refusal) return { action: 'refuse', message: refusal }
  }
  if (input.alreadyCurrent)
    return {
      action: 'refuse',
      message: `workflow cursor ${input.cursor} is already current; no repin was written`,
    }
  return { action: 'allow' }
}
