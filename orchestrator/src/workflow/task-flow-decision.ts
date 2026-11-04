// concern: task flow decisions
/** Pure policy for projecting task state and selecting its single open workflow stage. */

export type TaskFlowState = 'open' | 'done' | 'dropped'

export function taskFlowState(statusCategory: string | null | undefined): TaskFlowState | null {
  if (statusCategory === 'done') return 'done'
  if (statusCategory === 'dropped' || statusCategory === 'cancelled') return 'dropped'
  if (statusCategory == null) return null
  return 'open'
}

export type OpenTaskStage = { cursor: number; workflow: string; mode: string }

export type TaskStageSelection =
  | { action: 'open' }
  | { action: 'reuse'; stage: OpenTaskStage }
  | { action: 'refuse'; stage: OpenTaskStage }

export function decideTaskStageSelection(
  openStage: OpenTaskStage | null,
  requested: { cursor?: number; workflow: string; mode: string },
): TaskStageSelection {
  if (!openStage) return { action: 'open' }
  const same = requested.cursor
    ? requested.cursor === openStage.cursor
    : requested.workflow === openStage.workflow && requested.mode === openStage.mode
  return same ? { action: 'reuse', stage: openStage } : { action: 'refuse', stage: openStage }
}

export type TakeoverDecision =
  | { action: 'same-machine' }
  | { action: 'take-over'; fromMachineId: string }
  | { action: 'refuse'; fromMachineId: string; remedy: string }

export function decideWorkflowTakeover(input: {
  currentMachineId: string
  holderMachineId: string
  recordReachable: boolean
  recordRemedy?: string
}): TakeoverDecision {
  if (input.currentMachineId === input.holderMachineId) return { action: 'same-machine' }
  if (!input.recordReachable)
    return {
      action: 'refuse',
      fromMachineId: input.holderMachineId,
      remedy: input.recordRemedy ?? 'restore the hosted record connection and retry',
    }
  return { action: 'take-over', fromMachineId: input.holderMachineId }
}

export const workflowTakeoverNotice = (displayName: string) =>
  `Took over this workflow stage from ${displayName}.`
