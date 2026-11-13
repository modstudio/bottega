// concern: record-sync-task-flow
/** Applies revision-ordered task-flow and stage payloads to the hosted record. */

import type { SQL } from 'bun'
import { and, sql as drizzleSql, eq, isNull, lt } from 'drizzle-orm'
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

type NewTaskFlowStageValues = ReturnType<typeof taskFlowStageValues> & { projectId: string }

/** A new hosted stage takes its project's number sequence, so it cannot be written without one. */
function requireNewStageProject(
  values: ReturnType<typeof taskFlowStageValues>,
): NewTaskFlowStageValues {
  const { projectId } = values
  if (projectId) return { ...values, projectId }
  throw new OutboxRowError(
    `task_flow_stage projectId is required for a new hosted stage; run ${PLATFORM_SLUG} record push --backfill to enqueue the current stage, then ${PLATFORM_SLUG} record outbox retire orch:<row-id> --reason <text> for this entry`,
    'row-validation',
  )
}

/**
 * Writes a stage the record did not hold when this push looked, under its project
 * and the number its project sequence assigned. A concurrent push may insert it
 * first; the stage is then revised, so the newer revision applies rather than
 * reading as a collision.
 */
export async function writeNewTaskFlowStageValues(
  database: HostedRecordDatabase,
  values: NewTaskFlowStageValues,
  number: number,
) {
  const inserted = await database
    .insert(taskFlowStageRecord)
    .values({ ...values, number })
    .onConflictDoNothing({ target: taskFlowStageRecord.id })
    .returning({ id: taskFlowStageRecord.id })
  return inserted.length > 0 ? inserted : reviseTaskFlowStageValues(database, values)
}

/**
 * Revises a stage the record already holds, leaving the project and number the
 * record assigned. It is an UPDATE because the stage contract makes both
 * columns NOT NULL, and Postgres checks NOT NULL before it resolves an upsert
 * conflict, so a revision carrying no fresh number could not upsert.
 *
 * Only a strictly newer revision replaces the row. A stage written before stages
 * carried enforcement holds none, and a payload at that same revision fills
 * enforcement alone: an equal revision never replaces state, so a re-sent stage
 * cannot override what the record holds.
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
  const revised = await database
    .update(taskFlowStageRecord)
    .set(updates)
    .where(
      and(eq(taskFlowStageRecord.id, values.id), lt(taskFlowStageRecord.revision, values.revision)),
    )
    .returning({ id: taskFlowStageRecord.id })
  if (revised.length > 0 || values.enforcement === null) return revised
  return database
    .update(taskFlowStageRecord)
    .set({ enforcement: values.enforcement })
    .where(
      and(
        eq(taskFlowStageRecord.id, values.id),
        eq(taskFlowStageRecord.revision, values.revision),
        isNull(taskFlowStageRecord.enforcement),
      ),
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
    const database = drizzle({ client: tx })
    let written: { id: string }[]
    if (existingOwned) written = await reviseTaskFlowStageValues(database, values)
    else {
      const stage = requireNewStageProject(values)
      written = await writeNewTaskFlowStageValues(
        database,
        stage,
        await allocateRecordSequence(tx, stage.spaceId, stage.projectId, 'task_flow_stage'),
      )
    }
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
