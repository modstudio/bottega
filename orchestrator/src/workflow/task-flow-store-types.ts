// concern: task flow persistence types
/** Shared row and insert shapes for task-flow persistence. */

import type {
  TaskFlowIntentInput as RecordTaskFlowIntentInput,
  TaskFlowIntent,
} from '../record/record-task-flow-write-contract.ts'
import type { CursorOwner, CursorState } from './workflow-cursor-transition.ts'
import type { EnforcementMode } from './workflow-floor.ts'

type CursorOwnerMutation = { values: { sessionId?: CursorOwner | null } }
type CursorOwnerIntentShape<K extends TaskFlowIntent> = K extends 'compose'
  ? {
      stageInsert?: { sessionId: CursorOwner | null }
      stageChanges?: CursorOwnerMutation[]
    }
  : K extends 'stage-update'
    ? { stages: CursorOwnerMutation[] }
    : K extends 'advance' | 'await-ruling' | 'abandon'
      ? { stage: CursorOwnerMutation }
      : K extends 'handoff'
        ? { newStage: { sessionId: CursorOwner | null } }
        : object

/** Workflow write intents narrow cursor-stage owner values to the policy-produced brand. */
export type TaskFlowIntentInput<K extends TaskFlowIntent> = RecordTaskFlowIntentInput<K> &
  CursorOwnerIntentShape<K>

export type TaskFlowStageListInput<State extends string> = {
  project?: string
  sessionId?: string
  /** An empty list matches no stages. */
  workflowKeys?: readonly string[]
  states: readonly [State, ...State[]]
  /** Summary rows carry closed as '[]' and autonomy as null; do not read those fields. */
  view?: 'summary'
}

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
  handed_off_from_record_id: string | null
  updated_at: string
}

export function isKeylessExplore(row: {
  workflow_slug: string
  workflow_key?: string | null
}): boolean {
  return row.workflow_slug === 'explore' && !row.workflow_key
}

export type WorkflowCursorInsert = {
  recordId: string
  projectRecordId: string
  project: string
  workflow: string
  mode: string
  workflowKey: string
  taskRecordId: string | null
  taskFlowRecordId: string | null
  instanceId: string
  sessionId: CursorOwner | null
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

export type TaskFlowOpenStageWorktreeRow = {
  record_id: string
  number: number
  workflow: string
  project: string
  args: string
  closed: string
  revision: number
}

export type TaskFlowListedStageRow = TaskFlowStageCursorRow & {
  open_stage_count: number
  question_number: number | null
}

export type TaskFlowTextRow = {
  id: string
  cursor_record_id: string
  step_ordinal: number
  step_slug: string
  body: string
  created_at?: string
}
export type TaskFlowTextBodyRow = Omit<TaskFlowTextRow, 'id'>
export type TaskFlowUncopiedTextRow = {
  record_id: string
  step_slug: string
  body: string
  created_at: string
}

type TaskFlowObligationFloorRow = {
  id: string
  floor: string
  require_pull_request: boolean | number
  operator_ruling: boolean | number
  expected_exit_code: number
  expected_status: string
  floor_deferrable: boolean | number
  cursor_number: number
  cursor_project: string
}
export type TaskFlowOpenObligationRow = TaskFlowObligationFloorRow & {
  stepOrdinal: number
  stepSlug: string
}
export type TaskFlowStageSummaryRow = {
  stage: TaskFlowStageCursorRow
  obligations: TaskFlowOpenObligationRow[]
}
export type TaskFlowObligationRow = TaskFlowObligationFloorRow & {
  cursor_record_id: string
  satisfied_at: string | null
  abandoned_at: string | null
}

export type TaskFlowCloseOutStageRow = {
  id: number
  step_slug: string
  workflow_slug: string
  project: string
  args: string
}
export type TaskFlowWaitingQuestionRow = {
  id: number
  workflow_cursor_record_id: string
  project: string
  question_record_id: string
  task_key: string | null
  question: string
  waiting_since: string
  workflow_slug: string
  mode_slug: string
  args: string
  session_id: string | null
}
export type TaskFlowCursorWorkRow = { key: string; closed: string }
export type TaskFlowCursorLifecycleRow = {
  record_id: string
  number: number
  workflow_slug: string
  workflow_key: string | null
  created_at: string
  updated_at: string
  state: string
  closed: string
}
export type TaskFlowOpenSessionStageRow = {
  record_id: string
  number: number
  project: string
  workflow_slug: string
  mode_slug: string
  workflow_key: string
  step_slug: string
  step_actions: string[]
  state: string
  updated_at: string
  open_question_record_id: string | null
}
export type TaskFlowKeylessSessionCursorRow = {
  record_id: string
  number: number
  project: string
  workflow_slug: string
  step_slug: string
  session_id: string
  updated_at: string
  open_question_record_id: string | null
}
export type TaskFlowInboxQuestionRow = {
  number: number
  record_id: string
  asked_at: string
  question: string
  cursor_record_id: number
  project: string
  project_record_id: string | null
  workflow_slug: string
  mode_slug: string
  args: string
  ordinal: number
  step_slug: string
  session_id: string | null
}
export type TaskFlowRulingRow = Record<string, unknown> & { number: number }
export type TaskFlowRulingFileRow = {
  record_id: string
  number: number
  run_record_id: string | null
  root_id: string | null
  workflow_cursor_record_id: string | null
  workflow_cursor_number: number | null
  workflow_slug: string | null
  mode_slug: string | null
  workflow_owner: string | null
  workflow_updated_at: string | null
  question: string
  answer: string | null
  answer_basis: string | null
  answered_at: string | null
  answered_by: string | null
  answered_by_name: string | null
  answerer_kind: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturned_by_name: string | null
  replacement: string | null
  filed_as: string | null
  filed_ref: string | null
  filed_record_id: string | null
  filed_label: string | null
  filed_at: string | null
  repo: string | null
  cwd: string | null
  launch_key: string | null
  project_path: string | null
  args: string | null
}
export type TaskFlowQuestionCloseRow = {
  answered_at: string | null
  closed_at: string | null
  run_record_id: string | null
  workflow_cursor_record_id: string | null
  cursor_state: string | null
  root_id: string | null
  latest_status: string | null
}
export type TaskFlowOverturnRulingRow = {
  record_id: string
  number: number
  run_record_id: string | null
  root_id: string | null
  workflow_cursor_record_id: string | null
  workflow_owner: string | null
  workflow_updated_at: string | null
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturned_by_name: string | null
  overturn_reason: string | null
  replacement: string | null
}
export type TaskFlowPendingTaskLinkRow = { id: string; task_key: string; project: string }
export type TaskFlowLinkedTaskReferenceRow = { task_record_id: string; project: string }
export type TaskFlowTaskRulingRow = {
  question_id: number
  question_record_id: string
  run_record_id: string | null
  workflow_cursor_record_id: string | null
  question: string
  answer: string
  answer_basis: string | null
  answered_at: string
  answerer_kind: 'agent' | 'operator' | 'eval' | null
  answered_by_name: string | null
  overturned_at: string | null
  overturned_by_name: string | null
  replacement: string | null
  candidate_count: number
}

export function workflowStageInsert(input: {
  id: string
  flowRecordId: string
  projectId: string
  workflow: string
  mode: string
  workflowKey: string
  instanceId: string
  sessionId: NonNullable<TaskFlowIntentInput<'compose'>['stageInsert']>['sessionId']
  workflowVersionId: string
  catalogueVersionId: string
  arguments: Record<string, string>
  activeSlug: string
  activeOrdinal?: number
  closedStepNotes?: unknown[]
  autonomy: string | null
  totalSteps: number
  openedMachineId: string
  createdAt: string
}) {
  return {
    ...input,
    activeOrdinal: input.activeOrdinal ?? 0,
    state: 'running' as const,
    closedStepNotes: input.closedStepNotes ?? [],
    question: null,
    enforcement: 'floors' as const,
    takenOverFromMachineId: null,
    lastAdvancedMachineId: input.openedMachineId,
    updatedAt: input.createdAt,
  }
}
