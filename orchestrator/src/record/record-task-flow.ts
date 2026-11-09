// concern: hosted task-flow reads
/** Reads one tenant-bound flow and its open stage without exposing record storage to callers. */

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
    workflow: String(row.stage_workflow),
    mode: String(row.stage_mode),
    workflowVersionId: String(row.stage_workflow_version_id),
    catalogueVersionId: String(row.stage_catalogue_version_id),
    arguments: row.stage_arguments as Record<string, string>,
    activeOrdinal: Number(row.stage_active_ordinal),
    activeSlug: String(row.stage_active_slug),
    state: String(row.stage_state) as HostedStage['state'],
    closedStepNotes: row.stage_closed_step_notes as unknown[],
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

export async function readRecordTaskFlow(
  input: TenantPrincipal & { url: string; taskKey?: string; flowRecordId?: string },
): Promise<HostedTaskFlow> {
  const sql = recordPool(input.url)
  return sql.begin(async (tx) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT f.id,f.project_id,f.task_id,f.state,f.open_stage_record_id,
             f.opening_machine_id,f.updated_machine_id,f.revision,f.created_at,f.updated_at,
             s.id stage_id,s.flow_record_id stage_flow_record_id,s.workflow stage_workflow,
             s.mode stage_mode,s.workflow_version_id stage_workflow_version_id,
             s.catalogue_version_id stage_catalogue_version_id,s.arguments stage_arguments,
             s.active_ordinal stage_active_ordinal,s.active_slug stage_active_slug,s.state stage_state,
             s.closed_step_notes stage_closed_step_notes,s.total_steps stage_total_steps,
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
      SELECT s.id stage_id,s.flow_record_id stage_flow_record_id,s.workflow stage_workflow,
             s.mode stage_mode,s.workflow_version_id stage_workflow_version_id,
             s.catalogue_version_id stage_catalogue_version_id,s.arguments stage_arguments,
             s.active_ordinal stage_active_ordinal,s.active_slug stage_active_slug,s.state stage_state,
             s.closed_step_notes stage_closed_step_notes,s.total_steps stage_total_steps,
             s.opened_machine_id stage_opened_machine_id,
             s.taken_over_from_machine_id stage_taken_over_from_machine_id,
             s.last_advanced_machine_id stage_last_advanced_machine_id,s.revision stage_revision,
             s.created_at stage_created_at,s.updated_at stage_updated_at
      FROM task_flow_stage s
      WHERE s.space_id=${input.spaceId}::uuid AND s.flow_record_id=${row.id}::uuid
        AND (${row.open_stage_record_id ?? null}::uuid IS NULL OR s.id<>${row.open_stage_record_id ?? null}::uuid)
      ORDER BY s.updated_at`
    const otherStages = stageRows.map((stageRow: Record<string, unknown>) =>
      toHostedStage(stageRow),
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
              ...toHostedStage(row),
              holder: {
                id: String(row.stage_last_advanced_machine_id),
                displayName: String(row.holder_display_name),
              },
            },
      otherStages,
    }
  })
}
