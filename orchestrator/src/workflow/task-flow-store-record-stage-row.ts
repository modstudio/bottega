// concern: hosted task-flow stage row conversion
/** Converts hosted task-flow stages to the workflow read-port row shape. */

import type {
  HostedTaskFlowStageById,
  HostedTaskFlowStageList,
} from '../record/record-task-flow-contract.ts'
import type { TaskFlowStageCursorRow } from './task-flow-store-types.ts'

export type ListedItem = HostedTaskFlowStageList['items'][number]

export function required<T>(value: T | null | undefined, field: string): T {
  if (value == null)
    throw new Error(
      `hosted task-flow stage has no ${field}; repair the hosted task-flow row, then retry`,
    )
  return value
}

export function stageRow(item: ListedItem): TaskFlowStageCursorRow & { open_stage_count: number }
export function stageRow(item: ListedItem, includeOpenStageCount: false): TaskFlowStageCursorRow
export function stageRow(
  item: ListedItem,
  includeOpenStageCount = true,
): TaskFlowStageCursorRow & { open_stage_count?: number } {
  const { stage, flow } = item
  return {
    id: stage.number,
    record_id: stage.id,
    project: required(stage.projectName, 'project name'),
    workflow_slug: stage.workflow,
    mode_slug: stage.mode,
    workflow_key: stage.workflowKey ?? '',
    task_record_id: flow.taskId,
    // SQLite cannot persist a taskless flow, so preserve the port's existing taskless row shape.
    task_flow_record_id: flow.taskId === null ? null : stage.flowRecordId,
    instance_id: stage.instanceId ?? '',
    session_id: stage.sessionId ?? null,
    ordinal: stage.activeOrdinal,
    step_slug: stage.activeSlug,
    state: stage.state,
    workflow_version_record_id: stage.workflowVersionId,
    catalogue_version_record_id: stage.catalogueVersionId,
    workflow_version: required(stage.workflowVersionNumber, 'workflow version number'),
    catalogue_version: required(stage.catalogueVersionNumber, 'catalogue version number'),
    args: JSON.stringify(stage.arguments),
    autonomy: stage.autonomy ?? null,
    closed: JSON.stringify(stage.closedStepNotes),
    question: stage.question ?? null,
    total_steps: stage.totalSteps,
    created_at: stage.createdAt,
    updated_at: stage.updatedAt,
    enforcement: required(
      stage.enforcement,
      'enforcement mode',
    ) as TaskFlowStageCursorRow['enforcement'],
    opened_machine_id: stage.openedMachineId,
    taken_over_from_machine_id: stage.takenOverFromMachineId,
    last_advanced_machine_id: stage.lastAdvancedMachineId,
    revision: stage.revision,
    ...(includeOpenStageCount
      ? { open_stage_count: flow.taskId === null ? 0 : flow.openStageCount }
      : {}),
  }
}

export function stageItem(result: HostedTaskFlowStageById): ListedItem {
  return { stage: result.stage, flow: result.flow }
}
