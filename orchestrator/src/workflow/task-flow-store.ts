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
  textsForStage<T extends object>(stageRecordId: string): T[]
  textByRecordId<T extends object>(recordId: string): T | null
  textAttachmentByRecordId<T extends object>(recordId: string): T | null
  insertText(input: {
    recordId: string
    stageRecordId: string
    stepOrdinal: number
    stepSlug: string
    body: string
    createdAt: string
  }): string | null
  textRecordIdsForStage(stageRecordId: string): string[]
  copiedTextRecordIdsForStage(stageRecordId: string): string[]
  deleteTexts(recordIds: readonly string[]): void
  stageProject(recordId: string): string | null
  uncopiedTextsForStage<T extends object>(stageRecordId: string): T[]
  recordTextCopy(input: {
    recordId: string
    textRecordId: string
    stageRecordId: string
    documentReference: string
    copiedAt: string
  }): void
  liveTextAttachment(recordId: string): { cursor: number; step_slug: string; body: string } | null
  copiedTextReference(recordId: string): string | null
  openObligationRecordIds(stageRecordId: string): string[]
  openObligations<T extends object>(stageRecordId: string): T[]
  obligationByRecordId<T extends object>(recordId: string): T | null
  nextKeylessInstanceSlot(input: {
    projectRecordId: string
    workflow: string
    mode: string
    sessionId: string | null
    machineId: string
  }): number
  flowForTask(taskRecordId: string): { record_id: string; revision: number } | null
  hasStage(recordId: string): boolean
  assignStageTaskKey(input: {
    recordId: string
    workflowKey: string
    taskRecordId: string | null
    argumentsJson: string
    updatedAt: string
  }): void
  stagesNeedingTaskLink(project: string, workflowKey: string): Array<{
    record_id: string
    revision: number
    updated_at: string
  }>
  linkUnhostedStagesToTask(input: {
    taskRecordId: string
    project: string
    workflowKey: string
  }): number
  unlinkedLabelHolder(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): number | null
  updateReusedStage(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    revision: number
  }): void
  updateServedStage(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    ordinal: number
    stepSlug: string
    state: string
    question: string | null
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void
  resumeStageAfterRuling(input: {
    recordId: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void
  awaitStageRuling(input: {
    recordId: string
    argumentsJson: string
    closedJson: string
    question: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void
  abandonOpenObligations(stageRecordId: string, at: string, reason: string): void
  abandonStage(input: {
    recordId: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    machineId: string
    revision: number
  }): void
  clearFlowOpenStage(input: {
    recordId: string
    updatedAt: string
    machineId: string
    revision: number
  }): void
  insertObligation(input: {
    id: string
    stageRecordId: string
    stepOrdinal: number
    stepSlug: string
    floor: string
    requirePullRequest: boolean
    operatorRuling: boolean
    expectedExitCode: number
    expectedStatus: string
    floorDeferrable: boolean
    reason: string
    sessionId: string | null
    createdAt: string
  }): void
  satisfyObligation(input: {
    id: string
    stageRecordId: string
    satisfiedAt?: string | null
    satisfiedStepOrdinal?: number | null
    satisfiedStepSlug?: string | null
    satisfiedEvidence?: unknown
  }): void
  advanceStage(input: {
    recordId: string
    argumentsJson: string
    ordinal: number
    stepSlug: string
    state: string
    closedJson: string
    sessionId: string | null
    updatedAt: string
    takenOverFromMachineId: string | null
    machineId: string
    revision: number
  }): void
}

/** The single task-flow persistence seam. Hosted selection is added in part 2c-2. */
export function taskFlowStore(database: Database): TaskFlowStore {
  return sqliteTaskFlowStore(database)
}
