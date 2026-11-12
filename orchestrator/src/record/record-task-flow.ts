// concern: hosted task-flow reads
/** Reads one tenant-bound flow and its open stage without exposing record storage to callers. */

import type { SQL } from 'bun'

import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import { recordPool } from './record-pool.ts'
import {
  type HostedTaskFlow,
  type HostedTaskFlowObligationById,
  type HostedTaskFlowProjectReferenceCounts,
  type HostedTaskFlowStageById,
  type HostedTaskFlowStageList,
  type HostedTaskFlowTextById,
  RECORD_TASK_FLOW_NOT_FOUND_CODE,
  RECORD_TASK_FLOW_NOT_FOUND_MESSAGE,
  type TaskFlowReadQueryInput,
  type TaskFlowStageListQuery,
} from './record-task-flow-contract.ts'
import { taskFlowStageListNextCursor, taskFlowStageListSql } from './record-task-flow-list-query.ts'

export class RecordTaskFlowError extends Error {
  readonly status = 404
  readonly code = RECORD_TASK_FLOW_NOT_FOUND_CODE
}

type HostedStage = NonNullable<HostedTaskFlow['otherStages']>[number]
type HostedStageSummary = HostedTaskFlowStageList['items'][number]['stage']

const STAGE_SELECT = `
  s.id stage_id,s.flow_record_id stage_flow_record_id,s.project_id stage_project_id,
  sp.name stage_project_name,s.number stage_number,s.workflow stage_workflow,s.mode stage_mode,
  s.workflow_key stage_workflow_key,s.instance_id stage_instance_id,s.session_id stage_session_id,
  s.workflow_version_id stage_workflow_version_id,wv.n stage_workflow_version_number,
  s.catalogue_version_id stage_catalogue_version_id,cv.n stage_catalogue_version_number,
  s.arguments stage_arguments,s.active_ordinal stage_active_ordinal,s.active_slug stage_active_slug,
  s.state stage_state,s.closed_step_notes stage_closed_step_notes,s.question stage_question,
  s.autonomy stage_autonomy,s.enforcement stage_enforcement,s.total_steps stage_total_steps,
  s.opened_machine_id stage_opened_machine_id,
  s.taken_over_from_machine_id stage_taken_over_from_machine_id,
  s.last_advanced_machine_id stage_last_advanced_machine_id,s.revision stage_revision,
  s.created_at stage_created_at,s.updated_at stage_updated_at`

const FLOW_SELECT = `
  f.id,f.project_id,f.task_id,t.key task_key,f.state,f.open_stage_record_id,
  (SELECT count(*)::integer FROM task_flow_stage open_stage
   WHERE open_stage.flow_record_id=f.id AND open_stage.space_id=f.space_id
     AND open_stage.state NOT IN ('done','abandoned')) open_stage_count,
  f.opening_machine_id,f.updated_machine_id,f.revision,f.created_at,f.updated_at`

const STAGE_JOINS = `
  LEFT JOIN project sp ON sp.id=s.project_id AND sp.space_id=s.space_id
  LEFT JOIN workflow_version wv ON wv.id=s.workflow_version_id AND wv.space_id=s.space_id
  LEFT JOIN step_catalogue_version cv ON cv.id=s.catalogue_version_id AND cv.space_id=s.space_id`

function toHostedStageSummary(row: Record<string, unknown>): HostedStageSummary {
  return {
    id: String(row.stage_id),
    flowRecordId: String(row.stage_flow_record_id),
    projectId: row.stage_project_id == null ? null : String(row.stage_project_id),
    projectName: row.stage_project_name == null ? null : String(row.stage_project_name),
    number: row.stage_number == null ? null : Number(row.stage_number),
    workflow: String(row.stage_workflow),
    mode: String(row.stage_mode),
    workflowKey: row.stage_workflow_key == null ? null : String(row.stage_workflow_key),
    instanceId: row.stage_instance_id == null ? null : String(row.stage_instance_id),
    sessionId: row.stage_session_id == null ? null : String(row.stage_session_id),
    workflowVersionId: String(row.stage_workflow_version_id),
    workflowVersionNumber:
      row.stage_workflow_version_number == null ? null : Number(row.stage_workflow_version_number),
    catalogueVersionId: String(row.stage_catalogue_version_id),
    catalogueVersionNumber:
      row.stage_catalogue_version_number == null
        ? null
        : Number(row.stage_catalogue_version_number),
    arguments: row.stage_arguments as Record<string, string>,
    activeOrdinal: Number(row.stage_active_ordinal),
    activeSlug: String(row.stage_active_slug),
    state: String(row.stage_state) as HostedStage['state'],
    closedStepNotes: row.stage_closed_step_notes as unknown[],
    question: row.stage_question == null ? null : String(row.stage_question),
    autonomy: row.stage_autonomy == null ? null : String(row.stage_autonomy),
    enforcement: row.stage_enforcement == null ? null : String(row.stage_enforcement),
    totalSteps: Number(row.stage_total_steps),
    openedMachineId: String(row.stage_opened_machine_id),
    takenOverFromMachineId:
      row.stage_taken_over_from_machine_id == null
        ? null
        : String(row.stage_taken_over_from_machine_id),
    lastAdvancedMachineId: String(row.stage_last_advanced_machine_id),
    revision: Number(row.stage_revision),
    createdAt: recordIso(row.stage_created_at),
    updatedAt: recordIso(row.stage_updated_at),
  }
}

function toHostedStage(row: Record<string, unknown>): HostedStage {
  return {
    ...toHostedStageSummary(row),
    obligations: [],
    stepTexts: [],
    textCopies: [],
  }
}

function toHostedFlow(row: Record<string, unknown>): HostedTaskFlow['flow'] {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    taskKey: row.task_key == null ? null : String(row.task_key),
    state: String(row.state) as HostedTaskFlow['flow']['state'],
    openStageRecordId: row.open_stage_record_id == null ? null : String(row.open_stage_record_id),
    openStageCount: Number(row.open_stage_count),
    openingMachineId: String(row.opening_machine_id),
    updatedMachineId: String(row.updated_machine_id),
    revision: Number(row.revision),
    createdAt: recordIso(row.created_at),
    updatedAt: recordIso(row.updated_at),
  }
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : recordIso(value)
}

function toHostedObligation(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    stageRecordId: String(item.stage_record_id),
    stepOrdinal: Number(item.step_ordinal),
    stepSlug: String(item.step_slug),
    floor: String(item.floor),
    requirePullRequest: Boolean(item.require_pull_request),
    expectedExitCode: Number(item.expected_exit_code),
    expectedStatus: String(item.expected_status),
    floorDeferrable: Boolean(item.floor_deferrable),
    reason: String(item.reason),
    sessionId: item.session_id == null ? null : String(item.session_id),
    createdAt: recordIso(item.created_at),
    satisfiedAt: nullableIso(item.satisfied_at),
    satisfiedStepOrdinal:
      item.satisfied_step_ordinal == null ? null : Number(item.satisfied_step_ordinal),
    satisfiedStepSlug: item.satisfied_step_slug == null ? null : String(item.satisfied_step_slug),
    satisfiedEvidence: item.satisfied_evidence as unknown[] | null,
    abandonedAt: nullableIso(item.abandoned_at),
    abandonedReason: item.abandoned_reason == null ? null : String(item.abandoned_reason),
    operatorRuling: Boolean(item.operator_ruling),
  }
}

function toHostedStepText(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    stageRecordId: String(item.stage_record_id),
    stepOrdinal: Number(item.step_ordinal),
    stepSlug: String(item.step_slug),
    body: String(item.body),
    createdAt: recordIso(item.created_at),
  }
}

function toHostedTextCopy(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    workflowTextRecordId: String(item.workflow_text_record_id),
    stageRecordId: String(item.stage_record_id),
    taskDocumentReference: String(item.task_document_reference),
    copiedAt: recordIso(item.copied_at),
  }
}

async function stageChildren(tx: SQL, spaceId: string, flowId: string) {
  const obligations = await tx`
    SELECT o.* FROM workflow_obligation o JOIN task_flow_stage s ON s.id=o.stage_record_id
    WHERE o.space_id=${spaceId}::uuid AND s.flow_record_id=${flowId}::uuid ORDER BY o.created_at,o.id`
  const texts = await tx`
    SELECT t.* FROM workflow_step_text t JOIN task_flow_stage s ON s.id=t.stage_record_id
    WHERE t.space_id=${spaceId}::uuid AND s.flow_record_id=${flowId}::uuid ORDER BY t.created_at,t.id`
  const copies = await tx`
    SELECT c.* FROM workflow_text_copy c JOIN task_flow_stage s ON s.id=c.stage_record_id
    WHERE c.space_id=${spaceId}::uuid AND s.flow_record_id=${flowId}::uuid ORDER BY c.copied_at,c.id`
  return {
    obligations: obligations.map(toHostedObligation),
    stepTexts: texts.map(toHostedStepText),
    textCopies: copies.map(toHostedTextCopy),
  }
}

function withChildren(
  stage: HostedStage,
  children: Awaited<ReturnType<typeof stageChildren>>,
): HostedStage {
  return {
    ...stage,
    obligations: children.obligations.filter(
      (row: { stageRecordId: string }) => row.stageRecordId === stage.id,
    ),
    stepTexts: children.stepTexts.filter(
      (row: { stageRecordId: string }) => row.stageRecordId === stage.id,
    ),
    textCopies: children.textCopies.filter(
      (row: { stageRecordId: string }) => row.stageRecordId === stage.id,
    ),
  }
}

export async function readRecordTaskFlow(
  input: TenantPrincipal & { url: string } & TaskFlowReadQueryInput,
): Promise<HostedTaskFlow> {
  const sql = recordPool(input.url)
  return sql.begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx.unsafe(
      `SELECT ${FLOW_SELECT},${STAGE_SELECT},
              coalesce(m.display_name,m.short_name,m.name) holder_display_name
       FROM task_flow f
       LEFT JOIN hub_task t ON t.id=f.task_id AND t.space_id=f.space_id
       LEFT JOIN task_flow_stage s ON s.id=f.open_stage_record_id AND s.space_id=f.space_id
       ${STAGE_JOINS}
       LEFT JOIN machine m ON m.id=s.last_advanced_machine_id
       WHERE f.space_id=$1::uuid
         AND ($2::uuid IS NULL OR f.id=$2::uuid)
         AND ($3::text IS NULL OR t.key=$3)
         AND ($4::uuid IS NULL OR f.task_id=$4::uuid)
       ORDER BY f.open_stage_record_id IS NULL, f.revision DESC, f.updated_at DESC, f.id
       LIMIT 1`,
      [input.spaceId, input.flowRecordId ?? null, input.taskKey ?? null, input.taskId ?? null],
    )
    const row = rows[0]
    if (!row) throw new RecordTaskFlowError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE)
    const stageRows = await tx.unsafe(
      `SELECT ${STAGE_SELECT}
       FROM task_flow_stage s
       ${STAGE_JOINS}
       WHERE s.space_id=$1::uuid AND s.flow_record_id=$2::uuid
         AND ($3::uuid IS NULL OR s.id<>$3::uuid)
       ORDER BY s.updated_at`,
      [input.spaceId, row.id, row.open_stage_record_id ?? null],
    )
    const children = await stageChildren(tx, input.spaceId, String(row.id))
    const otherStages = stageRows.map((stageRow: Record<string, unknown>) =>
      withChildren(toHostedStage(stageRow), children),
    )
    return {
      flow: toHostedFlow(row),
      stage:
        row.stage_id == null
          ? null
          : {
              ...withChildren(toHostedStage(row), children),
              holder: {
                id: String(row.stage_last_advanced_machine_id),
                displayName: String(row.holder_display_name),
              },
            },
      otherStages,
    }
  })
}

export async function listRecordTaskFlowStages(
  input: TenantPrincipal & { url: string } & TaskFlowStageListQuery,
): Promise<HostedTaskFlowStageList> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const query = taskFlowStageListSql(input.spaceId, input)
    query.values.push(input.limit + 1)
    const rows = await tx.unsafe(
      `SELECT ${STAGE_SELECT},${FLOW_SELECT}
       FROM task_flow_stage s
       JOIN task_flow f ON f.id=s.flow_record_id AND f.space_id=s.space_id
       LEFT JOIN hub_task t ON t.id=f.task_id AND t.space_id=f.space_id
       ${STAGE_JOINS}
       WHERE ${query.clauses.join(' AND ')}
       ORDER BY ${query.orderBy}
       LIMIT $${query.values.length}::integer`,
      query.values,
    )
    const truncated = rows.length > input.limit
    const pageRows = rows.slice(0, input.limit) as Array<Record<string, unknown>>
    const last = pageRows.at(-1)
    return {
      items: pageRows.map((row) => ({
        stage: toHostedStageSummary(row),
        flow: toHostedFlow(row),
      })),
      truncated,
      nextCursor: truncated ? taskFlowStageListNextCursor(input, last) : null,
    }
  })
}

export async function readRecordTaskFlowProjectReferenceCounts(
  input: TenantPrincipal & { url: string; projectId: string },
): Promise<HostedTaskFlowProjectReferenceCounts> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT
        (SELECT count(*)::integer FROM task_flow_stage
         WHERE space_id=${input.spaceId}::uuid AND project_id=${input.projectId}::uuid) stages,
        (SELECT count(*)::integer FROM task_flow
         WHERE space_id=${input.spaceId}::uuid AND project_id=${input.projectId}::uuid) flows`
    return { stages: Number(rows[0]?.stages ?? 0), flows: Number(rows[0]?.flows ?? 0) }
  })
}

export async function readRecordTaskFlowStage(
  input: TenantPrincipal & { url: string; id: string },
): Promise<HostedTaskFlowStageById> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx.unsafe(
      `SELECT ${STAGE_SELECT},${FLOW_SELECT}
       FROM task_flow_stage s
       JOIN task_flow f ON f.id=s.flow_record_id AND f.space_id=s.space_id
       LEFT JOIN hub_task t ON t.id=f.task_id AND t.space_id=f.space_id
       ${STAGE_JOINS}
       WHERE s.space_id=$1::uuid AND s.id=$2::uuid`,
      [input.spaceId, input.id],
    )
    const row = rows[0]
    if (!row) throw new RecordTaskFlowError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE)
    const children = await stageChildren(tx, input.spaceId, String(row.stage_flow_record_id))
    return { stage: withChildren(toHostedStage(row), children), flow: toHostedFlow(row) }
  })
}

export async function readRecordTaskFlowText(
  input: TenantPrincipal & { url: string; id: string },
): Promise<HostedTaskFlowTextById> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT t.*,s.id stage_id,s.number stage_number,
             c.id copy_id,c.workflow_text_record_id copy_workflow_text_record_id,
             c.stage_record_id copy_stage_record_id,
             c.task_document_reference copy_task_document_reference,c.copied_at copy_copied_at
      FROM workflow_step_text t
      JOIN task_flow_stage s ON s.id=t.stage_record_id AND s.space_id=t.space_id
      LEFT JOIN workflow_text_copy c
        ON c.workflow_text_record_id=t.id AND c.space_id=t.space_id
      WHERE t.space_id=${input.spaceId}::uuid AND t.id=${input.id}::uuid`
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new RecordTaskFlowError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE)
    return {
      text: toHostedStepText(row),
      stage: {
        id: String(row.stage_id),
        number: row.stage_number == null ? null : Number(row.stage_number),
      },
      copy:
        row.copy_id == null
          ? null
          : toHostedTextCopy({
              id: row.copy_id,
              workflow_text_record_id: row.copy_workflow_text_record_id,
              stage_record_id: row.copy_stage_record_id,
              task_document_reference: row.copy_task_document_reference,
              copied_at: row.copy_copied_at,
            }),
    }
  })
}

export async function readRecordTaskFlowObligation(
  input: TenantPrincipal & { url: string; id: string },
): Promise<HostedTaskFlowObligationById> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT o.*,s.id stage_id,s.number stage_number,s.state stage_state
      FROM workflow_obligation o
      JOIN task_flow_stage s ON s.id=o.stage_record_id AND s.space_id=o.space_id
      WHERE o.space_id=${input.spaceId}::uuid AND o.id=${input.id}::uuid`
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) throw new RecordTaskFlowError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE)
    return {
      obligation: toHostedObligation(row),
      stage: {
        id: String(row.stage_id),
        number: row.stage_number == null ? null : Number(row.stage_number),
        state: String(row.stage_state) as HostedTaskFlowObligationById['stage']['state'],
      },
    }
  })
}
