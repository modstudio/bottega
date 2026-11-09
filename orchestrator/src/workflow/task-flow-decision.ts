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
  recordRead: 'reachable' | 'unreachable' | 'not-attempted'
  recordRemedy?: string
  workflowKey?: string
}): TakeoverDecision {
  if (input.currentMachineId === input.holderMachineId) return { action: 'same-machine' }
  if (input.recordRead !== 'reachable')
    return {
      action: 'refuse',
      fromMachineId: input.holderMachineId,
      remedy:
        input.recordRead === 'not-attempted'
          ? `the stage was last advanced by this holder and was not read from the record; re-run with --key ${input.workflowKey || '<task key>'}`
          : (input.recordRemedy ?? 'restore the hosted record connection and retry'),
    }
  return { action: 'take-over', fromMachineId: input.holderMachineId }
}

export type TaskFlowReadDecision = 'local' | 'hosted' | 'refresh'
export function decideTaskFlowReadThrough(input: {
  localFlowExists: boolean
  localFlowRevision: number | null
  hostedFlowRevision: number
  localStageRevision: number | null
  hostedStageRevision: number | null
}): TaskFlowReadDecision {
  if (!input.localFlowExists) return 'hosted'
  if (input.localFlowRevision !== null && input.hostedFlowRevision > input.localFlowRevision)
    return 'refresh'
  if (input.hostedStageRevision == null) return 'local'
  if (input.localStageRevision == null) return 'hosted'
  return input.hostedStageRevision > input.localStageRevision ? 'refresh' : 'local'
}

const TASK_FLOW_ROUTE_RELEASE_REMEDY =
  'record API predates task-flow read; release hosted-api, then retry'

export type TaskFlowReadStatus =
  | { status: 'reachable'; holder?: { id: string; displayName: string } }
  | { status: 'unreachable'; remedy: string }
  | { status: 'not-attempted' }

export function decideTaskFlowReadStatus(input: {
  status: number | null
  recognizedNotFound: boolean
  configured: boolean
  errorRemedy: string
}): TaskFlowReadStatus {
  if (input.status === 404 && input.recognizedNotFound) return { status: 'reachable' }
  if (input.status === 404 || input.status === 405)
    return { status: 'unreachable', remedy: TASK_FLOW_ROUTE_RELEASE_REMEDY }
  if (!input.configured) return { status: 'unreachable', remedy: input.errorRemedy }
  return { status: 'unreachable', remedy: input.errorRemedy }
}

export const workflowTakeoverNotice = (displayName: string) =>
  `Took over this workflow stage from ${displayName}.`
