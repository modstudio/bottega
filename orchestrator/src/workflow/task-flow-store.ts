// concern: task flow persistence port
/** Names the task-flow questions and write intents used by the workflow engine. */

import type { Database } from 'bun:sqlite'
import type { CursorState } from './workflow-cursor-transition.ts'
import type { EnforcementMode } from './workflow-floor.ts'
import { sqliteTaskFlowStore } from './task-flow-store-sqlite.ts'

export type TaskFlowStageCursorRow = {
  id: number
  record_id: string
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  task_record_id: string | null
  task_flow_record_id: string | null
  instance_id: string
  session_id: string | null
  ordinal: number
  step_slug: string
  state: CursorState
  workflow_version_record_id: string
  catalogue_version_record_id: string
  workflow_version: number
  catalogue_version: number
  args: string
  autonomy: string | null
  closed: string
  question: string | null
  total_steps: number
  created_at: string
  enforcement: EnforcementMode
  opened_machine_id: string | null
  taken_over_from_machine_id: string | null
  last_advanced_machine_id: string | null
  revision: number
  updated_at: string
}

export type WorkflowCursorInsert = {
  recordId: string
  projectRecordId?: string
  project: string
  workflow: string
  mode: string
  workflowKey: string
  taskRecordId: string | null
  taskFlowRecordId: string | null
  instanceId: string
  sessionId: string | null
  workflowVersionRecordId: string
  catalogueVersionRecordId: string
  args: string
  autonomy: string | null
  ordinal: number
  stepSlug: string
  state: string
  closed: string
  question: string | null
  totalSteps: number
  createdAt: string
  updatedAt: string
  enforcement: string
  openedMachineId: string | null
  takenOverFromMachineId: string | null
  lastAdvancedMachineId: string | null
  revision: number
}

export type TaskFlowProjectionRow = {
  record_id: string
  open_stage_cursor_record_id: string | null
}

export interface TaskFlowStore {
  retireStageIdentity(input: {
    project: string
    workflow: string
    mode: string
    key: string
    exceptRecordId: string | null
  }): void
  conflictingHostedStage(input: {
    projectRecordId: string
    workflow: string
    mode: string
    key: string
    recordId: string
  }): { number: number; record_id: string } | null
  insertStage(row: WorkflowCursorInsert, conflict: 'local-identity' | 'hosted-record'): string
  openStageForTask(taskRecordId: string): TaskFlowStageCursorRow | null
  flowRecordIdForTask(taskRecordId: string): string | null
  cacheAdoptedFlow(input: {
    project: string
    taskRecordId: string
    cursorRecordId: string
    flowRecordId: string
    flowRevision: number
    stageRevision: number
    state: string | null
    at: string
    machineId: string
  }): void
  stampFlowMachine(flowRecordId: string, machineId: string): void
  stampStageMachine(
    cursorRecordId: string,
    revisionIncrement: 0 | 1,
    machineId: string,
  ): void
  projectFlow(input: {
    recordId: string
    project: string
    taskRecordId: string
    state: string | null
    at: string
    machineId: string
  }): TaskFlowProjectionRow
  flowProjectionForTask(taskRecordId: string): TaskFlowProjectionRow | null
  attachStageToFlow(input: {
    flowRecordId: string
    cursorRecordId: string
    at: string
    machineId: string
  }): void
  stageByHandle(cursor: number): TaskFlowStageCursorRow | null
  stageByRecordId(recordId: string): TaskFlowStageCursorRow | null
  latestStageForTask(input: {
    project: string
    workflow: string
    mode: string
    taskRecordId: string
  }): TaskFlowStageCursorRow | null
  openKeylessStages(input: {
    project: string
    workflow: string
    mode: string
    sessionId: string
    untouched: boolean
  }): TaskFlowStageCursorRow[]
  activeStageModes(input: {
    project: string
    workflow: string
    taskRecordId: string | null
    key: string
    sessionId: string
  }): Array<{ mode_slug: string }>
  listOpenStages<T extends object>(input: {
    project?: string
    sessionId?: string
  }): T[]
  openStageWorktrees(): Array<{
    number: number
    workflow: string
    project: string
    args: string
  }>
  activeStageAutonomy(project: string, taskRecordId: string): Array<{ autonomy: string | null }>
  stageIdentityMap(): Array<{ number: number; record_id: string }>
  stageHoldingTaskKey(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): { id: number } | null
  stageRevision(recordId: string): number | null
  flowState(recordId: string): {
    record_id: string
    revision: number
    open_stage_cursor_record_id: string | null
  } | null
}

/** The single task-flow persistence seam. Hosted selection is added in part 2c-2. */
export function taskFlowStore(database: Database): TaskFlowStore {
  return sqliteTaskFlowStore(database)
}
