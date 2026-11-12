// concern: record-sync-task-flow
/** Applies revision-ordered task-flow and stage payloads to the hosted record. */

import type { SQL } from 'bun'
import { sql as drizzleSql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import {
  taskFlow as taskFlowRecord,
  taskFlowStage as taskFlowStageRecord,
} from '../../../shared/record/schema-task-flow.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { OutboxRowError } from './outbox-failure.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import type { ExistingEvidenceOwned, RequireOwnedUpsert } from './record-evidence-references.ts'
import { allocateRecordSequence } from './record-sequence.ts'
import type { RecordPayload, RecordPrincipal } from './record-sync-contract.ts'
import { bindPrincipal } from './record-sync-principal.ts'

const nullableString = (value: unknown) => (value == null ? null : String(value))

export function taskFlowValues(row: RecordPayload) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId: String(row.projectId),
    taskId: nullableString(row.taskId),
    state: String(row.state),
    openStageRecordId: nullableString(row.openStageRecordId),
    openingMachineId: String(row.openingMachineId),
    updatedMachineId: String(row.updatedMachineId),
    revision: Number(row.revision),
    createdAt: recordDate(row.createdAt),
    updatedAt: recordDate(row.updatedAt),
  }
}

export function taskFlowStageValues(row: RecordPayload) {
  return {
    id: String(row.id),
    spaceId: String(row.spaceId),
    projectId: nullableString(row.projectId),
    flowRecordId: String(row.flowRecordId),
    workflow: String(row.workflow),
    mode: String(row.mode),
    workflowKey: nullableString(row.workflowKey),
    instanceId: nullableString(row.instanceId),
    sessionId: nullableString(row.sessionId),
    workflowVersionId: String(row.workflowVersionId),
    catalogueVersionId: String(row.catalogueVersionId),
    arguments: row.arguments,
    activeOrdinal: Number(row.activeOrdinal),
    activeSlug: String(row.activeSlug),
    state: String(row.state),
    closedStepNotes: row.closedStepNotes,
    question: nullableString(row.question),
    autonomy: nullableString(row.autonomy),
    enforcement: nullableString(row.enforcement),
    totalSteps: Number(row.totalSteps),
    openedMachineId: String(row.openedMachineId),
    takenOverFromMachineId: nullableString(row.takenOverFromMachineId),
    lastAdvancedMachineId: String(row.lastAdvancedMachineId),
    revision: Number(row.revision),
    createdAt: recordDate(row.createdAt),
    updatedAt: recordDate(row.updatedAt),
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
  number: number | null = null,
) {
  const insert = { ...values, number }
  const {
    id: _id,
    createdAt: _createdAt,
    flowRecordId: _flowRecordId,
    projectId: _projectId,
    number: _number,
    ...updates
  } = insert
  return database
    .insert(taskFlowStageRecord)
    .values(insert)
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
    const existing = await tx`SELECT id FROM task_flow_stage WHERE id=${values.id}::uuid`
    if (!existing[0] && !values.projectId)
      throw new OutboxRowError(
        'task_flow_stage projectId is required for a new hosted stage; repair the outbox payload from the current local stage and retry record push',
        'row-validation',
      )
    const number = existing[0]
      ? null
      : await allocateRecordSequence(tx, values.spaceId, values.projectId!, 'task_flow_stage')
    const existingOwned = await existingEvidenceOwned(
      tx,
      'task_flow_stage',
      values.id,
      values.openedMachineId,
      principal,
      { scope: 'space-principal' },
    )
    const written = await applyTaskFlowStageValues(drizzle({ client: tx }), values, number)
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
