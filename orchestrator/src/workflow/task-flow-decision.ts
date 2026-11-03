// concern: task flow decisions
/** Pure policy for projecting task state and selecting its single open workflow stage. */

export type TaskFlowState = 'open' | 'done' | 'dropped'

export function taskFlowState(statusCategory: string | null | undefined): TaskFlowState {
  if (statusCategory === 'done') return 'done'
  if (statusCategory === 'dropped' || statusCategory === 'cancelled') return 'dropped'
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
