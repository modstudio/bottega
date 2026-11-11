// concern: task flow persistence port
/** The task-flow persistence port and its resolver. */

import type { Database } from 'bun:sqlite'
import type {
  TaskFlowIntent,
  TaskFlowIntentInput,
  TaskFlowIntentResult,
} from '../record/record-task-flow-write-contract.ts'
import { sqliteTaskFlowStore } from './task-flow-store-sqlite.ts'
import type {
  TaskFlowCloseOutStageRow,
  TaskFlowCursorLifecycleRow,
  TaskFlowCursorWorkRow,
  TaskFlowInboxQuestionRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowListedStageRow,
  TaskFlowObligationRow,
  TaskFlowOpenObligationRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowProjectionRow,
  TaskFlowQuestionCloseRow,
  TaskFlowQuestionOutboxRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowStageCursorRow,
  TaskFlowTaskRulingRow,
  TaskFlowTextBodyRow,
  TaskFlowTextRow,
  TaskFlowUncopiedTextRow,
  TaskFlowWaitingQuestionRow,
  WorkflowCursorInsert,
} from './task-flow-store-types.ts'

export type {
  TaskFlowCloseOutStageRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowListedStageRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowQuestionOutboxRow,
  TaskFlowRulingFileRow,
  TaskFlowWaitingQuestionRow,
} from './task-flow-store-types.ts'

/**
 * Names the task-flow questions and write intents used by the workflow engine.
 * Migrations and their preflights write the local tables directly by design, as do the hosted-cache
 * writer in record/record-cache-workflow.ts and refresh in workflow/task-flow-read-through.ts.
 */
export interface TaskFlowStore {
  write<K extends TaskFlowIntent>(
    intent: K,
    payload: TaskFlowIntentInput<K>,
    applied?: TaskFlowIntentResult<K> | null,
  ): TaskFlowIntentResult<K>
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
  flowProjectionForTask(taskRecordId: string): TaskFlowProjectionRow | null
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
  listOpenStages(input: { project?: string; sessionId?: string }): TaskFlowListedStageRow[]
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
  textsForStage(stageRecordId: string): TaskFlowTextRow[]
  textByRecordId(recordId: string): TaskFlowTextBodyRow | null
  textAttachmentByRecordId(recordId: string): TaskFlowTextRow | null
  textRecordIdsForStage(stageRecordId: string): string[]
  copiedTextRecordIdsForStage(stageRecordId: string): string[]
  stageProject(recordId: string): string | null
  uncopiedTextsForStage(stageRecordId: string): TaskFlowUncopiedTextRow[]
  liveTextAttachment(recordId: string): { cursor: number; step_slug: string; body: string } | null
  copiedTextReference(recordId: string): string | null
  openObligationRecordIds(stageRecordId: string): string[]
  openObligations(stageRecordId: string): TaskFlowOpenObligationRow[]
  obligationByRecordId(recordId: string): TaskFlowObligationRow | null
  nextKeylessInstanceSlot(input: {
    projectRecordId: string
    workflow: string
    mode: string
    sessionId: string | null
    machineId: string
  }): number
  flowForTask(taskRecordId: string): { record_id: string; revision: number } | null
  hasStage(recordId: string): boolean
  stagesNeedingTaskLink(
    project: string,
    workflowKey: string,
  ): Array<{
    record_id: string
    revision: number
    updated_at: string
  }>
  unlinkedLabelHolder(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): number | null
  closeOutShipTaskStage(
    sessionId: string,
    project: string,
    branch: string,
  ): TaskFlowCloseOutStageRow[]
  waitingWorkflowQuestions(): TaskFlowWaitingQuestionRow[]
  cursorWorkForSession(sessionId: string): TaskFlowCursorWorkRow[]
  cursorLifecycleForSession(sessionId: string): TaskFlowCursorLifecycleRow[]
  openStagesForSession(sessionId: string): TaskFlowOpenSessionStageRow[]
  openWorkflowQuestionCountForSession(sessionId: string): number
  workflowInboxQuestions(): TaskFlowInboxQuestionRow[]
  rulingRows(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }): TaskFlowRulingRow[]
  rulingFileQuestion(questionId: string): TaskFlowRulingFileRow | null
  questionOutboxRow(questionId: string): TaskFlowQuestionOutboxRow | null
  questionCloseFacts(questionId: string): TaskFlowQuestionCloseRow | null
  overturnRulingRow(questionId: string): TaskFlowOverturnRulingRow | null
  unlinkedWorkflowQuestionIds(project: string, workflowKey: string): string[]
  pendingTaskLinks(table: 'workflow_cursor' | 'question'): TaskFlowPendingTaskLinkRow[]
  linkedTaskReferences(table: 'workflow_cursor' | 'question'): TaskFlowLinkedTaskReferenceRow[]
  projectReferenceCounts(projectRecordId: string): {
    workflow_cursor: number
    task_flow: number
  }
  relinkProjectReferences(
    oldRecordId: string,
    newRecordId: string,
  ): Record<'task_flow' | 'workflow_cursor', number>
  renameStageProject(currentName: string, nextName: string): void
  taskRulingRows(project: string, taskRecordId: string, limit: number): TaskFlowTaskRulingRow[]
  localQuestionProjects(): Array<{ project: string | null }>
}

/** Resolves task-flow persistence to the local SQLite adapter. */
export function taskFlowStore(database: Database): TaskFlowStore {
  return sqliteTaskFlowStore(database)
}
