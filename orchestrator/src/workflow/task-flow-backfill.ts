// concern: task-flow-backfill
/**
 * Enqueues complete local task-flow rows that the hosted record does not hold.
 * A keyless compose can land between the presence read and the push; the push remains conflict-safe,
 * but this module does not close that race.
 */

import type { Database } from 'bun:sqlite'
import { v5 } from 'uuid'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import type { RecordSpaceMembership } from '../../../shared/record-space-membership.ts'
import { recordWriteSpace } from '../../../shared/record-write-space.ts'
import { nowIso, writeTransaction } from '../database/db.ts'
import { declaredProjectRecordSpace } from '../project/declared-record-space.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { TASK_FLOW_PRESENCE_BATCH_MAX } from '../record/record-task-flow-contract.ts'
import {
  insertLegacyTaskFlow,
  linkLegacyStageToFlow,
  type LegacyTaskFlowInsert,
} from './task-flow-store-sqlite-write.ts'
import type { TaskFlowStageCursorRow } from './task-flow-store-types.ts'

const LEGACY_TASKLESS_FLOW_NAMESPACE = v5.URL

type FlowRow = {
  record_id: string
  project_record_id: string
  project_name: string
  project_settings: string
  task_record_id: string | null
  state: string
  open_stage_cursor_record_id: string | null
  opening_machine_id: string
  updated_machine_id: string
  revision: number
  created_at: string
  updated_at: string
}

type StageRow = TaskFlowStageCursorRow & {
  project_record_id: string
  project_name: string
  project_settings: string
  opened_machine_id: string
  last_advanced_machine_id: string
}

type TaskFlowBackfillHold = { project: string; rows: number; reason: string }
export type TaskFlowBackfillResult = {
  enqueuedFlows: number
  enqueuedStages: number
  held: readonly TaskFlowBackfillHold[]
  failure?: string
}
export type TaskFlowBackfillInspection = {
  flows: number
  stages: number
  held: readonly TaskFlowBackfillHold[]
  failure?: string
}
export type TaskFlowBackfillAccess = {
  client: Pick<RecordTaskFlowClient, 'readTaskFlowPresence'>
  memberships: readonly RecordSpaceMembership[]
  personalSpaceId: string | null
  projectSpaces?: Record<string, string>
}

export function taskFlowBackfillUnavailable(
  reason: string,
  kind: 'backfill',
): TaskFlowBackfillResult
export function taskFlowBackfillUnavailable(
  reason: string,
  kind?: 'inspection',
): TaskFlowBackfillInspection
export function taskFlowBackfillUnavailable(
  reason: string,
  kind: 'backfill' | 'inspection' = 'inspection',
): TaskFlowBackfillResult | TaskFlowBackfillInspection {
  return kind === 'backfill'
    ? { enqueuedFlows: 0, enqueuedStages: 0, held: [], failure: reason }
    : { flows: 0, stages: 0, held: [], failure: reason }
}

export function legacyTasklessFlowRecordId(stageRecordId: string): string {
  return v5(JSON.stringify(['legacy-taskless-flow', stageRecordId]), LEGACY_TASKLESS_FLOW_NAMESPACE)
}

export function legacyTaskFlowRecordId(taskRecordId: string): string {
  return v5(JSON.stringify(['legacy-task-flow', taskRecordId]), LEGACY_TASKLESS_FLOW_NAMESPACE)
}

function stageFlowRecordId(
  row: Pick<StageRow, 'record_id' | 'task_flow_record_id'>,
  repaired: ReadonlyMap<string, string>,
): string {
  return (
    row.task_flow_record_id ??
    repaired.get(row.record_id) ??
    legacyTasklessFlowRecordId(row.record_id)
  )
}

function hasPendingOutbox(database: Database, kind: string, rowId: string): boolean {
  return Boolean(
    database
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM outbox WHERE kind=? AND row_id=? AND synced_at IS NULL
         AND quarantined_at IS NULL AND retired_at IS NULL LIMIT 1`,
      )
      .get(kind, rowId),
  )
}

function enqueue(
  database: Database,
  kind: 'task_flow' | 'task_flow_stage',
  rowId: string,
  payload: Record<string, unknown>,
): void {
  insertOutboxRow(database, {
    recordId: newRecordId(),
    kind,
    rowId,
    payload: stringifyOutboxPayload(kind, payload),
    createdAt: nowIso(),
  })
}

function flowPayload(row: FlowRow): Record<string, unknown> {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    taskId: row.task_record_id,
    state: row.state,
    openStageRecordId: row.open_stage_cursor_record_id,
    openingMachineId: row.opening_machine_id,
    updatedMachineId: row.updated_machine_id,
    machineId: machineId(),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function tasklessFlow(row: StageRow, id: string): LegacyTaskFlowInsert {
  const open = row.state === 'running' || row.state === 'awaiting-ruling'
  return {
    id,
    projectId: row.project_record_id,
    taskId: null,
    state: open ? 'open' : row.state === 'done' ? 'done' : 'dropped',
    openStageRecordId: open ? row.record_id : null,
    openingMachineId: row.opened_machine_id,
    updatedMachineId: row.last_advanced_machine_id,
    revision: 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function legacyFlowPayload(
  row: FlowRow | LegacyTaskFlowInsert,
  projectName: string,
): Record<string, unknown> {
  const legacy = 'record_id' in row
  return {
    id: legacy ? row.record_id : row.id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: legacy ? row.project_record_id : row.projectId,
    projectName,
    taskId: legacy ? row.task_record_id : row.taskId,
    state: row.state,
    openStageRecordId: legacy ? row.open_stage_cursor_record_id : row.openStageRecordId,
    openingMachineId: legacy ? row.opening_machine_id : row.openingMachineId,
    updatedMachineId: legacy ? row.updated_machine_id : row.updatedMachineId,
    machineId: machineId(),
    revision: row.revision,
    createdAt: legacy ? row.created_at : row.createdAt,
    updatedAt: legacy ? row.updated_at : row.updatedAt,
  }
}

function taskFlowForLegacyStages(taskRecordId: string, stages: StageRow[]): LegacyTaskFlowInsert {
  const projects = new Set(stages.map((row) => row.project_record_id))
  if (projects.size !== 1)
    throw new Error(
      `legacy task ${taskRecordId} has unlinked stages in more than one project; repair the local task-flow links, then retry`,
    )
  const open = stages.find((row) => row.state === 'running' || row.state === 'awaiting-ruling')
  if (open)
    throw new Error(
      `legacy task ${taskRecordId} has open unlinked stage ${open.record_id}; repair the local task-flow link, then retry`,
    )
  const created = [...stages].sort((left, right) =>
    left.created_at.localeCompare(right.created_at),
  )[0]!
  const updated = [...stages].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  )[0]!
  return {
    id: legacyTaskFlowRecordId(taskRecordId),
    taskId: taskRecordId,
    projectId: created.project_record_id,
    state: stages.some((row) => row.state === 'done') ? 'done' : 'dropped',
    openStageRecordId: null,
    openingMachineId: created.opened_machine_id,
    updatedMachineId: updated.last_advanced_machine_id,
    revision: 1,
    createdAt: created.created_at,
    updatedAt: updated.updated_at,
  }
}

function stagePayload(row: StageRow, flowRecordId: string): Record<string, unknown> {
  return {
    id: row.record_id,
    spaceId: PLATFORM_SPACE_ID,
    projectId: row.project_record_id,
    projectName: row.project_name,
    flowRecordId,
    workflow: row.workflow_slug,
    mode: row.mode_slug,
    workflowKey: row.workflow_key,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    workflowVersionId: row.workflow_version_record_id,
    catalogueVersionId: row.catalogue_version_record_id,
    arguments: JSON.parse(row.args),
    activeOrdinal: row.ordinal,
    activeSlug: row.step_slug,
    state: row.state,
    closedStepNotes: JSON.parse(row.closed),
    question: row.question,
    autonomy: row.autonomy,
    enforcement: row.enforcement,
    totalSteps: row.total_steps,
    openedMachineId: row.opened_machine_id,
    takenOverFromMachineId: row.taken_over_from_machine_id,
    lastAdvancedMachineId: row.last_advanced_machine_id,
    machineId: machineId(),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function localFlows(database: Database): FlowRow[] {
  return database
    .query<FlowRow, []>(
      `SELECT flow.*,project.name project_name,project.settings project_settings FROM task_flow flow
       JOIN project ON project.record_id=flow.project_record_id ORDER BY flow.record_id`,
    )
    .all()
}

function localStages(database: Database): StageRow[] {
  return database
    .query<StageRow, []>(
      `SELECT cursor.*,project.name project_name,project.settings project_settings FROM workflow_cursor cursor
       JOIN project ON project.record_id=cursor.project_record_id ORDER BY cursor.record_id`,
    )
    .all()
}

function rowDeclaredSpace(
  row: FlowRow | StageRow,
  overrides?: Record<string, string>,
): string | null {
  return declaredProjectRecordSpace(row.project_settings, overrides?.[row.project_name])
}

type SpaceRows = { flows: FlowRow[]; stages: StageRow[] }
type Selection = {
  absentFlows: FlowRow[]
  absentStages: StageRow[]
  held: TaskFlowBackfillHold[]
}

function routeRows(
  flows: FlowRow[],
  stages: StageRow[],
  access: TaskFlowBackfillAccess,
): { spaces: Map<string, SpaceRows>; held: TaskFlowBackfillHold[] } {
  const spaces = new Map<string, SpaceRows>()
  const holds = new Map<string, TaskFlowBackfillHold>()
  const destination = (row: FlowRow | StageRow): string | null => {
    const decision = recordWriteSpace(
      { kind: 'project', name: row.project_name },
      {
        declaredSpaces: { [row.project_name]: rowDeclaredSpace(row, access.projectSpaces) },
        personalSpaceId: access.personalSpaceId,
        memberships: access.memberships,
      },
    )
    if (!('refused' in decision)) return decision.spaceId
    const key = `${row.project_name}\0${decision.remedy}`
    const hold = holds.get(key) ?? {
      project: row.project_name,
      rows: 0,
      reason: decision.remedy,
    }
    hold.rows++
    holds.set(key, hold)
    return null
  }
  for (const row of flows) {
    const spaceId = destination(row)
    if (spaceId) {
      const grouped = spaces.get(spaceId) ?? { flows: [], stages: [] }
      grouped.flows.push(row)
      spaces.set(spaceId, grouped)
    }
  }
  for (const row of stages) {
    const spaceId = destination(row)
    if (spaceId) {
      const grouped = spaces.get(spaceId) ?? { flows: [], stages: [] }
      grouped.stages.push(row)
      spaces.set(spaceId, grouped)
    }
  }
  return { spaces, held: [...holds.values()] }
}

async function selectAbsentTaskFlows(
  database: Database,
  access: TaskFlowBackfillAccess,
): Promise<Selection> {
  if (!access.client.readTaskFlowPresence)
    throw new Error('record API predates task-flow presence reads; release hosted-api, then retry')
  const routed = routeRows(localFlows(database), localStages(database), access)
  const presentFlows = new Set<string>()
  const presentStages = new Set<string>()
  for (const [spaceId, rows] of routed.spaces) {
    const count = Math.max(rows.flows.length, rows.stages.length)
    for (let offset = 0; offset < count; offset += TASK_FLOW_PRESENCE_BATCH_MAX) {
      const presence = await access.client.readTaskFlowPresence(
        {
          flowIds: rows.flows
            .slice(offset, offset + TASK_FLOW_PRESENCE_BATCH_MAX)
            .map((row) => row.record_id),
          stageIds: rows.stages
            .slice(offset, offset + TASK_FLOW_PRESENCE_BATCH_MAX)
            .map((row) => row.record_id),
        },
        { destinationSpaceId: spaceId },
      )
      for (const id of presence.flowIds) presentFlows.add(id)
      for (const id of presence.stageIds) presentStages.add(id)
    }
  }
  return {
    absentFlows: [...routed.spaces.values()]
      .flatMap((rows) => rows.flows)
      .filter((row) => !presentFlows.has(row.record_id)),
    absentStages: [...routed.spaces.values()]
      .flatMap((rows) => rows.stages)
      .filter((row) => !presentStages.has(row.record_id)),
    held: routed.held,
  }
}

export async function inspectTaskFlowBackfill(
  database: Database,
  access: TaskFlowBackfillAccess,
): Promise<TaskFlowBackfillInspection> {
  const selected = await selectAbsentTaskFlows(database, access)
  return {
    flows: selected.absentFlows.length,
    stages: selected.absentStages.length,
    held: selected.held,
  }
}

export async function backfillTaskFlowRecords(
  database: Database,
  access: TaskFlowBackfillAccess,
): Promise<TaskFlowBackfillResult> {
  const selected = await selectAbsentTaskFlows(database, access)
  const flows = selected.absentFlows.filter(
    (row) => !hasPendingOutbox(database, 'task_flow', row.record_id),
  )
  const stages = selected.absentStages.filter(
    (row) => !hasPendingOutbox(database, 'task_flow_stage', row.record_id),
  )
  const localFlowByTask = new Map(
    localFlows(database).flatMap((row) =>
      row.task_record_id ? [[row.task_record_id, row] as const] : [],
    ),
  )
  const taskStages = new Map<string, StageRow[]>()
  for (const stage of stages) {
    if (
      stage.task_flow_record_id ||
      !stage.task_record_id ||
      localFlowByTask.has(stage.task_record_id)
    )
      continue
    const grouped = taskStages.get(stage.task_record_id) ?? []
    grouped.push(stage)
    taskStages.set(stage.task_record_id, grouped)
  }
  const mintedTaskFlows = new Map(
    [...taskStages].map(([taskRecordId, grouped]) => [
      taskRecordId,
      taskFlowForLegacyStages(taskRecordId, grouped),
    ]),
  )
  return writeTransaction(() => {
    let enqueuedFlows = 0
    for (const row of flows) {
      enqueue(database, 'task_flow', row.record_id, flowPayload(row))
      enqueuedFlows++
    }
    const repaired = new Map<string, string>()
    for (const [taskRecordId, flow] of mintedTaskFlows) {
      insertLegacyTaskFlow(database, flow)
      const projectName = taskStages.get(taskRecordId)![0]!.project_name
      enqueue(database, 'task_flow', flow.id, legacyFlowPayload(flow, projectName))
      enqueuedFlows++
      localFlowByTask.set(taskRecordId, {
        record_id: flow.id,
        project_record_id: flow.projectId,
        project_name: projectName,
        project_settings: taskStages.get(taskRecordId)![0]!.project_settings,
        task_record_id: taskRecordId,
        state: flow.state,
        open_stage_cursor_record_id: null,
        opening_machine_id: flow.openingMachineId,
        updated_machine_id: flow.updatedMachineId,
        revision: flow.revision,
        created_at: flow.createdAt,
        updated_at: flow.updatedAt,
      })
    }
    for (const row of stages.filter((stage) => !stage.task_flow_record_id)) {
      let flowRecordId: string
      if (row.task_record_id) {
        flowRecordId = localFlowByTask.get(row.task_record_id)!.record_id
      } else {
        flowRecordId = legacyTasklessFlowRecordId(row.record_id)
        const flow = tasklessFlow(row, flowRecordId)
        insertLegacyTaskFlow(database, flow)
        if (!hasPendingOutbox(database, 'task_flow', flowRecordId)) {
          enqueue(database, 'task_flow', flowRecordId, legacyFlowPayload(flow, row.project_name))
          enqueuedFlows++
        }
      }
      linkLegacyStageToFlow(database, row.record_id, flowRecordId)
      repaired.set(row.record_id, flowRecordId)
    }
    let enqueuedStages = 0
    for (const row of stages) {
      const flowRecordId = stageFlowRecordId(row, repaired)
      enqueue(database, 'task_flow_stage', row.record_id, stagePayload(row, flowRecordId))
      enqueuedStages++
    }
    return { enqueuedFlows, enqueuedStages, held: selected.held }
  }, database)
}
