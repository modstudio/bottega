// concern: hosted task-flow reads
/** Reads one tenant-bound flow and its open stage without exposing record storage to callers. */

import type { SQL } from 'bun'

import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import { recordPool } from './record-pool.ts'
import {
  type HostedTaskFlow,
  RECORD_TASK_FLOW_NOT_FOUND_MESSAGE,
} from './record-task-flow-contract.ts'

export class RecordTaskFlowError extends Error {
  readonly status = 404
  readonly code = RECORD_TASK_FLOW_NOT_FOUND_CODE
}
const RECORD_TASK_FLOW_NOT_FOUND_CODE = 'task_flow_not_found'

type HostedStage = NonNullable<HostedTaskFlow['otherStages']>[number]

function toHostedStage(row: Record<string, unknown>): HostedStage {
  return {
    id: String(row.stage_id),
    flowRecordId: String(row.stage_flow_record_id),
    projectId: String(row.stage_project_id),
    number: Number(row.stage_number),
    workflow: String(row.stage_workflow),
    mode: String(row.stage_mode),
    workflowKey: String(row.stage_workflow_key),
    instanceId: String(row.stage_instance_id),
    sessionId: row.stage_session_id == null ? null : String(row.stage_session_id),
    workflowVersionId: String(row.stage_workflow_version_id),
    catalogueVersionId: String(row.stage_catalogue_version_id),
    arguments: row.stage_arguments as Record<string, string>,
    activeOrdinal: Number(row.stage_active_ordinal),
    activeSlug: String(row.stage_active_slug),
    state: String(row.stage_state) as HostedStage['state'],
    closedStepNotes: row.stage_closed_step_notes as unknown[],
    question: row.stage_question == null ? null : String(row.stage_question),
    autonomy: row.stage_autonomy == null ? null : String(row.stage_autonomy),
    enforcement: String(row.stage_enforcement),
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
    obligations: [],
    stepTexts: [],
    textCopies: [],
  }
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : recordIso(value)
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
    obligations: obligations.map((item: Record<string, unknown>) => ({
      id: String(item.id), stageRecordId: String(item.stage_record_id),
      stepOrdinal: Number(item.step_ordinal), stepSlug: String(item.step_slug), floor: String(item.floor),
      requirePullRequest: Boolean(item.require_pull_request), expectedExitCode: Number(item.expected_exit_code),
      expectedStatus: String(item.expected_status), floorDeferrable: Boolean(item.floor_deferrable),
      reason: String(item.reason), sessionId: item.session_id == null ? null : String(item.session_id),
      createdAt: recordIso(item.created_at), satisfiedAt: nullableIso(item.satisfied_at),
      satisfiedStepOrdinal: item.satisfied_step_ordinal == null ? null : Number(item.satisfied_step_ordinal),
      satisfiedStepSlug: item.satisfied_step_slug == null ? null : String(item.satisfied_step_slug),
      satisfiedEvidence: item.satisfied_evidence as unknown[] | null,
      abandonedAt: nullableIso(item.abandoned_at),
      abandonedReason: item.abandoned_reason == null ? null : String(item.abandoned_reason),
      operatorRuling: Boolean(item.operator_ruling),
    })),
    stepTexts: texts.map((item: Record<string, unknown>) => ({
      id: String(item.id), stageRecordId: String(item.stage_record_id), stepOrdinal: Number(item.step_ordinal),
      stepSlug: String(item.step_slug), body: String(item.body), createdAt: recordIso(item.created_at),
    })),
    textCopies: copies.map((item: Record<string, unknown>) => ({
      id: String(item.id), workflowTextRecordId: String(item.workflow_text_record_id),
      stageRecordId: String(item.stage_record_id), taskDocumentReference: String(item.task_document_reference),
      copiedAt: recordIso(item.copied_at),
    })),
  }
}

function withChildren(stage: HostedStage, children: Awaited<ReturnType<typeof stageChildren>>): HostedStage {
  return {
    ...stage,
    obligations: children.obligations.filter((row) => row.stageRecordId === stage.id),
    stepTexts: children.stepTexts.filter((row) => row.stageRecordId === stage.id),
    textCopies: children.textCopies.filter((row) => row.stageRecordId === stage.id),
  }
}

export async function readRecordTaskFlow(
  input: TenantPrincipal & { url: string; taskKey?: string; flowRecordId?: string },
): Promise<HostedTaskFlow> {
  const sql = recordPool(input.url)
  return sql.begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT f.id,f.project_id,f.task_id,f.state,f.open_stage_record_id,
             f.opening_machine_id,f.updated_machine_id,f.revision,f.created_at,f.updated_at,
             s.id stage_id,s.flow_record_id stage_flow_record_id,s.project_id stage_project_id,
             s.number stage_number,s.workflow stage_workflow,s.mode stage_mode,
             s.workflow_key stage_workflow_key,s.instance_id stage_instance_id,s.session_id stage_session_id,
             s.workflow_version_id stage_workflow_version_id,
             s.catalogue_version_id stage_catalogue_version_id,s.arguments stage_arguments,
             s.active_ordinal stage_active_ordinal,s.active_slug stage_active_slug,s.state stage_state,
             s.closed_step_notes stage_closed_step_notes,s.question stage_question,s.autonomy stage_autonomy,
             s.enforcement stage_enforcement,s.total_steps stage_total_steps,
             s.opened_machine_id stage_opened_machine_id,
             s.taken_over_from_machine_id stage_taken_over_from_machine_id,
             s.last_advanced_machine_id stage_last_advanced_machine_id,s.revision stage_revision,
             s.created_at stage_created_at,s.updated_at stage_updated_at,
             coalesce(m.display_name,m.short_name,m.name) holder_display_name
      FROM task_flow f
      JOIN hub_task t ON t.id=f.task_id AND t.space_id=f.space_id
      LEFT JOIN task_flow_stage s ON s.id=f.open_stage_record_id AND s.space_id=f.space_id
      LEFT JOIN machine m ON m.id=s.last_advanced_machine_id
      WHERE f.space_id=${input.spaceId}::uuid
        AND (${input.flowRecordId ?? null}::uuid IS NULL OR f.id=${input.flowRecordId ?? null}::uuid)
        AND (${input.taskKey ?? null}::text IS NULL OR t.key=${input.taskKey ?? null})
      ORDER BY f.open_stage_record_id IS NULL, f.revision DESC, f.updated_at DESC, f.id
      LIMIT 1`
    const row = rows[0]
    if (!row) throw new RecordTaskFlowError(RECORD_TASK_FLOW_NOT_FOUND_MESSAGE)
    const stageRows = await tx`
      SELECT s.id stage_id,s.flow_record_id stage_flow_record_id,s.project_id stage_project_id,
             s.number stage_number,s.workflow stage_workflow,s.mode stage_mode,
             s.workflow_key stage_workflow_key,s.instance_id stage_instance_id,s.session_id stage_session_id,
             s.workflow_version_id stage_workflow_version_id,
             s.catalogue_version_id stage_catalogue_version_id,s.arguments stage_arguments,
             s.active_ordinal stage_active_ordinal,s.active_slug stage_active_slug,s.state stage_state,
             s.closed_step_notes stage_closed_step_notes,s.question stage_question,s.autonomy stage_autonomy,
             s.enforcement stage_enforcement,s.total_steps stage_total_steps,
             s.opened_machine_id stage_opened_machine_id,
             s.taken_over_from_machine_id stage_taken_over_from_machine_id,
             s.last_advanced_machine_id stage_last_advanced_machine_id,s.revision stage_revision,
             s.created_at stage_created_at,s.updated_at stage_updated_at
      FROM task_flow_stage s
      WHERE s.space_id=${input.spaceId}::uuid AND s.flow_record_id=${row.id}::uuid
        AND (${row.open_stage_record_id ?? null}::uuid IS NULL OR s.id<>${row.open_stage_record_id ?? null}::uuid)
      ORDER BY s.updated_at`
    const children = await stageChildren(tx, input.spaceId, String(row.id))
    const otherStages = stageRows.map((stageRow: Record<string, unknown>) =>
      withChildren(toHostedStage(stageRow), children),
    )
    return {
      flow: {
        id: String(row.id),
        projectId: String(row.project_id),
        taskId: String(row.task_id),
        state: String(row.state) as HostedTaskFlow['flow']['state'],
        openStageRecordId:
          row.open_stage_record_id == null ? null : String(row.open_stage_record_id),
        openingMachineId: String(row.opening_machine_id),
        updatedMachineId: String(row.updated_machine_id),
        revision: Number(row.revision),
        createdAt: recordIso(row.created_at),
        updatedAt: recordIso(row.updated_at),
      },
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
