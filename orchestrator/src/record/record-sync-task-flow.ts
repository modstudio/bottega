// concern: record-sync-task-flow
/** Applies revision-ordered task-flow and stage payloads to the hosted record. */

import type { SQL } from 'bun'
import { and, sql as drizzleSql, eq, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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

/** Writes a stage the record does not hold yet, numbered by its project sequence. */
export async function insertTaskFlowStageValues(
  database: HostedRecordDatabase,
  values: ReturnType<typeof taskFlowStageValues>,
  number: number,
) {
  return database
    .insert(taskFlowStageRecord)
    .values({ ...values, number })
    .onConflictDoNothing({ target: taskFlowStageRecord.id })
    .returning({ id: taskFlowStageRecord.id })
}

/**
 * Revises a stage the record already holds, leaving the project and number the
 * record assigned. It is an UPDATE because the stage contract will make both
 * columns NOT NULL, and Postgres checks NOT NULL before it resolves an upsert
 * conflict, so a revision carrying no fresh number could not upsert.
 */
export async function reviseTaskFlowStageValues(
  database: HostedRecordDatabase,
  values: ReturnType<typeof taskFlowStageValues>,
) {
  const {
    id: _id,
    createdAt: _createdAt,
    flowRecordId: _flowRecordId,
    projectId: _projectId,
    ...updates
  } = values
  return database
    .update(taskFlowStageRecord)
    .set(updates)
    .where(
      and(eq(taskFlowStageRecord.id, values.id), lt(taskFlowStageRecord.revision, values.revision)),
    )
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
    if (!existingOwned && !values.projectId)
      throw new OutboxRowError(
        `task_flow_stage projectId is required for a new hosted stage; run ${PLATFORM_SLUG} record push --backfill to enqueue the current stage, then ${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text> for this entry`,
        'row-validation',
      )
    const database = drizzle({ client: tx })
    const written = existingOwned
      ? await reviseTaskFlowStageValues(database, values)
      : await insertTaskFlowStageValues(
          database,
          values,
          await allocateRecordSequence(tx, values.spaceId, values.projectId!, 'task_flow_stage'),
        )
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
