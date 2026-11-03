// concern: record-sync-task-flow
/** Applies revision-ordered task-flow and stage payloads to the hosted record. */
import type { SQL } from 'bun'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import {
  taskFlow as taskFlowRecord,
  taskFlowStage as taskFlowStageRecord,
} from '../../../shared/record/schema-task-flow.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'

const date = (value: unknown) => new Date(String(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))

export function taskFlowValues(row: RecordPayload) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId: String(row.projectId),
    taskId: String(row.taskId),
    state: String(row.state),
    openStageRecordId: nullableString(row.openStageRecordId),
    openingMachineId: String(row.openingMachineId),
    updatedMachineId: String(row.updatedMachineId),
    revision: Number(row.revision),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

export function taskFlowStageValues(row: RecordPayload) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    flowRecordId: String(row.flowRecordId),
    workflow: String(row.workflow),
    mode: String(row.mode),
    workflowVersionId: String(row.workflowVersionId),
    catalogueVersionId: String(row.catalogueVersionId),
    arguments: row.arguments,
    activeOrdinal: Number(row.activeOrdinal),
    activeSlug: String(row.activeSlug),
    state: String(row.state),
    closedStepNotes: row.closedStepNotes,
    totalSteps: Number(row.totalSteps),
    openedMachineId: String(row.openedMachineId),
    takenOverFromMachineId: nullableString(row.takenOverFromMachineId),
    lastAdvancedMachineId: String(row.lastAdvancedMachineId),
    revision: Number(row.revision),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  }
}

type HostedRecordDatabase = ReturnType<typeof drizzle>

export async function applyTaskFlowValues(
  database: HostedRecordDatabase,
  values: ReturnType<typeof taskFlowValues>,
) {
  const { id: _id, createdAt: _createdAt, ...updates } = values
  return database
    .insert(taskFlowRecord)
    .values(values)
    .onConflictDoUpdate({
      target: taskFlowRecord.id,
      set: updates,
      setWhere: drizzleSql`excluded.revision > ${taskFlowRecord.revision}`,
    })
    .returning({ id: taskFlowRecord.id })
}

export async function applyTaskFlowStageValues(
  database: HostedRecordDatabase,
  values: ReturnType<typeof taskFlowStageValues>,
) {
  const { id: _id, createdAt: _createdAt, ...updates } = values
  return database
    .insert(taskFlowStageRecord)
    .values(values)
    .onConflictDoUpdate({
      target: taskFlowStageRecord.id,
      set: updates,
      setWhere: drizzleSql`excluded.revision > ${taskFlowStageRecord.revision}`,
    })
    .returning({ id: taskFlowStageRecord.id })
}

async function pushTaskFlow(
  postgres: SQL,
  row: RecordPayload,
  principal: RecordPrincipal,
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const values = taskFlowValues(row)
    const existingOwned = await existingEvidenceOwned(
      tx,
      'task_flow',
      values.id,
      values.openingMachineId,
      principal,
      { scope: 'space-principal' },
    )
    const written = await applyTaskFlowValues(drizzle({ client: tx }), values)
    requireOwnedUpsert(written, 'task_flow', values.id, existingOwned)
  })
}

async function pushTaskFlowStage(
  postgres: SQL,
  row: RecordPayload,
  principal: RecordPrincipal,
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) {
  await postgres.begin(async (tx) => {
    await bindPrincipal(tx, principal)
    const values = taskFlowStageValues(row)
    const existingOwned = await existingEvidenceOwned(
      tx,
      'task_flow_stage',
      values.id,
      values.openedMachineId,
      principal,
      { scope: 'space-principal' },
    )
    const written = await applyTaskFlowStageValues(drizzle({ client: tx }), values)
    requireOwnedUpsert(written, 'task_flow_stage', values.id, existingOwned)
  })
}

export const taskFlowRecordKinds = (
  existingEvidenceOwned: ExistingEvidenceOwned<SQL>,
  requireOwnedUpsert: RequireOwnedUpsert,
) =>
  ({
    task_flow: {
      ...OUTBOX_PAYLOAD_CONTRACTS.task_flow,
      push: (postgres: SQL, row: RecordPayload, principal: RecordPrincipal) =>
        pushTaskFlow(postgres, row, principal, existingEvidenceOwned, requireOwnedUpsert),
    },
    task_flow_stage: {
      ...OUTBOX_PAYLOAD_CONTRACTS.task_flow_stage,
      push: (postgres: SQL, row: RecordPayload, principal: RecordPrincipal) =>
        pushTaskFlowStage(postgres, row, principal, existingEvidenceOwned, requireOwnedUpsert),
    },
  }) as const
