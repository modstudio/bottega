// concern: task flow persistence port
/** The task-flow persistence port and its resolver. */

import type { Database } from 'bun:sqlite'
import {
  TASK_FLOW_STAGE_STATES,
  type TaskFlowStageState,
} from '../record/record-task-flow-contract.ts'
import type {
  TaskFlowIntentResult,
  TaskFlowLiveIntent,
} from '../record/record-task-flow-write-contract.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { hostedTaskFlowLocalStore } from './task-flow-store-hosted.ts'
import type { TaskFlowWriteMethod } from './task-flow-store-methods.ts'
import { resolveTaskFlowReadStore } from './task-flow-store-record.ts'
import { sqliteTaskFlowLocalStore, sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'
import {
  repairUnlinkedKeylessStagesSqlite,
  type TaskFlowSqliteWriteResult,
} from './task-flow-store-sqlite-write.ts'
import type {
  TaskFlowCloseOutStageRow,
  TaskFlowCursorLifecycleRow,
  TaskFlowCursorWorkRow,
  TaskFlowInboxQuestionRow,
  TaskFlowIntentInput,
  TaskFlowKeylessSessionCursorRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowListedStageRow,
  TaskFlowObligationRow,
  TaskFlowOpenObligationRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOpenStageWorktreeRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowProjectionRow,
  TaskFlowQuestionCloseRow,
  TaskFlowRulingFileRow,
  TaskFlowRulingRow,
  TaskFlowStageCursorRow,
  TaskFlowStageSummaryRow,
  TaskFlowTaskRulingRow,
  TaskFlowTextBodyRow,
  TaskFlowTextRow,
  TaskFlowUncopiedTextRow,
  TaskFlowWaitingQuestionRow,
} from './task-flow-store-types.ts'
import type { WorkflowCursorHandoffLink } from './workflow-cursor-transition.ts'

export type {
  TaskFlowCloseOutStageRow,
  TaskFlowLinkedTaskReferenceRow,
  TaskFlowListedStageRow,
  TaskFlowOpenSessionStageRow,
  TaskFlowOverturnRulingRow,
  TaskFlowPendingTaskLinkRow,
  TaskFlowRulingFileRow,
  TaskFlowWaitingQuestionRow,
} from './task-flow-store-types.ts'
export { isKeylessExplore } from './task-flow-store-types.ts'

/** Reads machine-local cursor/task links with their already-known project owners. */
export async function localTaskReferencesForSession(
  database: Database,
  sessionId: string,
): Promise<Array<{ recordId: string; project: string }>> {
  return (
    await sqliteTaskFlowReadStore(database).listStages({
      sessionId,
      states: TASK_FLOW_STAGE_STATES,
    })
  ).flatMap((row) =>
    row.task_record_id ? [{ recordId: row.task_record_id, project: row.project }] : [],
  )
}

/**
 * Names the task-flow questions and write intents used by the workflow engine.
 * Migrations and their preflights write the local tables directly by design.
 */
interface TaskFlowQueries {
  write<K extends TaskFlowLiveIntent>(
    intent: K,
    payload: TaskFlowIntentInput<K>,
    applied?: TaskFlowIntentResult<K> | null,
  ): TaskFlowSqliteWriteResult<K>
  retireStageIdentity(input: {
    project: string
    workflow: string
    mode: string
    key: string
    exceptRecordId: string | null
  }): void
  openStageForTask(taskRecordId: string): TaskFlowStageCursorRow | null
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
  stageByHandle(project: string | undefined, cursor: number): TaskFlowStageCursorRow | null
  stageByRecordId(recordId: string): TaskFlowStageCursorRow | null
  stageSummaries(recordIds: readonly string[]): TaskFlowStageSummaryRow[]
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
  listStages(input: {
    project?: string
    sessionId?: string
    states: readonly [TaskFlowStageState, ...TaskFlowStageState[]]
  }): TaskFlowListedStageRow[]
  keyedStageHistory(input: { since: string }): TaskFlowStageCursorRow[]
  /** Reads open cursor worktree rows ordered by project, then cursor number. */
  openStageWorktrees(): TaskFlowOpenStageWorktreeRow[]
  activeStageAutonomy(project: string, taskRecordId: string): Array<{ autonomy: string | null }>
  stageIdentityMap(): Array<{ number: number; record_id: string }>
  stageHoldingTaskKey(input: {
    project: string
    workflow: string
    mode: string
    key: string
  }): { id: number } | null
  flowState(recordId: string): {
    record_id: string
    revision: number
    open_stage_cursor_record_id: string | null
    parent_flow_record_id: string | null
  } | null
  textsForFlowLineage(flowRecordId: string, stageRecordId: string): TaskFlowTextRow[]
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
  keylessSessionCursors(project: string | null): TaskFlowKeylessSessionCursorRow[]
  workflowInboxQuestions(): TaskFlowInboxQuestionRow[]
  rulingRows(input: {
    kind: 'workflow' | 'run' | 'all'
    since?: string
    after: number | null
    cursor: number | null
  }): TaskFlowRulingRow[]
  rulingFileQuestion(questionId: string): TaskFlowRulingFileRow | null
  questionCloseFacts(questionId: string): TaskFlowQuestionCloseRow | null
  overturnRulingRow(questionId: string): TaskFlowOverturnRulingRow | null
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

type TaskFlowReadMethod = Exclude<keyof TaskFlowQueries, TaskFlowWriteMethod>

type AsyncTaskFlowReads = {
  [K in TaskFlowReadMethod]: TaskFlowQueries[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}

/** Synchronous writes and reads that must remain atomic inside a local transaction. */
export interface TaskFlowLocalStore extends Pick<TaskFlowQueries, TaskFlowWriteMethod> {}

/** Async task-flow reads, implemented locally now and by the hosted record in the next slice. */
export interface TaskFlowReadStore extends AsyncTaskFlowReads {}

export interface TaskFlowHistoryMaintenanceStore {
  repairUnlinkedKeylessStages(): number
}

/** Resolves sign-in history maintenance to the workflow-owned local store. */
export function taskFlowHistoryMaintenanceStore(
  database: Database,
): TaskFlowHistoryMaintenanceStore {
  return {
    repairUnlinkedKeylessStages: () => repairUnlinkedKeylessStagesSqlite(database),
  }
}

/** Reads complete handoff lineages from authoritative stage rows, including closed ancestors. */
export async function taskFlowHandoffLinks(
  store: TaskFlowReadStore,
  terminalRecordIds: readonly string[],
): Promise<WorkflowCursorHandoffLink[]> {
  const links: WorkflowCursorHandoffLink[] = []
  const visited = new Set<string>()
  const pending = [...terminalRecordIds]
  while (pending.length) {
    const recordId = pending.pop()!
    if (visited.has(recordId)) continue
    visited.add(recordId)
    const row = await store.stageByRecordId(recordId)
    if (!row) continue
    links.push({
      record_id: row.record_id,
      handed_off_from_record_id: row.handed_off_from_record_id,
    })
    if (row.handed_off_from_record_id) pending.push(row.handed_off_from_record_id)
  }
  return links
}

/** Resolves task-flow writes and transaction-bound reads to local SQLite. */
export function taskFlowLocalStore(database: Database): TaskFlowLocalStore {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  return decision.verdict === 'hosted'
    ? hostedTaskFlowLocalStore(database)
    : sqliteTaskFlowLocalStore(database)
}

export function taskFlowWritesHosted(database: Database): boolean {
  return currentRecordWriteDecision(database).verdict === 'hosted'
}

export function taskFlowStoreMode(database: Database): 'hosted' | 'local-authoritative' {
  const decision = currentRecordWriteDecision(database)
  throwIfRecordRefused(decision)
  return decision.verdict
}

export function writeLocalAdvance(
  database: Database,
  payload: TaskFlowIntentInput<'advance'>,
  hosted: TaskFlowIntentResult<'advance'> | null,
): void {
  taskFlowLocalStore(database).write('advance', payload, hosted)
}

/** Resolves task-flow reads to the authoritative store for this install. */
export function taskFlowReadStore(
  database: Database,
  client?: Parameters<typeof resolveTaskFlowReadStore>[1],
): TaskFlowReadStore {
  return resolveTaskFlowReadStore(database, client)
}

/** Returns the open workflow question, if any, that prevents changing this cursor. */
export async function openWorkflowQuestionForCursor(
  store: TaskFlowReadStore,
  cursorRecordId: string,
): Promise<TaskFlowWaitingQuestionRow | undefined> {
  return (await store.waitingWorkflowQuestions()).find(
    (question) => question.workflow_cursor_record_id === cursorRecordId,
  )
}

/** Count local task-flow rows while deciding whether a local project row can be removed. */
export async function localTaskFlowProjectReferenceCounts(
  database: Database,
  projectRecordId: string,
): Promise<{ workflow_cursor: number; task_flow: number }> {
  return sqliteTaskFlowReadStore(database).projectReferenceCounts(projectRecordId)
}
