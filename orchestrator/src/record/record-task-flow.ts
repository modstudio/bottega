// concern: hosted task-flow reads
/** Reads one tenant-bound flow and its open stage without exposing record storage to callers. */
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import type { HostedTaskFlow } from './record-task-flow-contract.ts'

export class RecordTaskFlowError extends Error {
  readonly status = 404
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
             s.id stage_id,s.flow_record_id,s.workflow,s.mode,s.workflow_version_id,
             s.catalogue_version_id,s.arguments,s.active_ordinal,s.active_slug,s.state stage_state,
             s.closed_step_notes,s.total_steps,s.opened_machine_id,s.taken_over_from_machine_id,
             s.last_advanced_machine_id,s.revision stage_revision,s.created_at stage_created_at,
             s.updated_at stage_updated_at,
             coalesce(m.display_name,m.short_name,m.name) holder_display_name
      FROM task_flow f
      JOIN hub_task t ON t.id=f.task_id AND t.space_id=f.space_id
      LEFT JOIN task_flow_stage s ON s.id=f.open_stage_record_id AND s.space_id=f.space_id
      LEFT JOIN machine m ON m.id=s.last_advanced_machine_id
      WHERE f.space_id=${input.spaceId}::uuid
        AND (${input.flowRecordId ?? null}::uuid IS NULL OR f.id=${input.flowRecordId ?? null}::uuid)
        AND (${input.taskKey ?? null}::text IS NULL OR t.key=${input.taskKey ?? null})
      LIMIT 1`
    const row = rows[0]
    if (!row) throw new RecordTaskFlowError('hosted task flow was not found')
    const iso = (value: unknown) => new Date(String(value)).toISOString()
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
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      },
      stage:
        row.stage_id == null
          ? null
          : {
              id: String(row.stage_id),
              flowRecordId: String(row.flow_record_id),
              workflow: String(row.workflow),
              mode: String(row.mode),
              workflowVersionId: String(row.workflow_version_id),
              catalogueVersionId: String(row.catalogue_version_id),
              arguments: row.arguments as Record<string, string>,
              activeOrdinal: Number(row.active_ordinal),
              activeSlug: String(row.active_slug),
              state: String(row.stage_state) as NonNullable<HostedTaskFlow['stage']>['state'],
              closedStepNotes: row.closed_step_notes as unknown[],
              totalSteps: Number(row.total_steps),
              openedMachineId: String(row.opened_machine_id),
              takenOverFromMachineId:
                row.taken_over_from_machine_id == null
                  ? null
                  : String(row.taken_over_from_machine_id),
              lastAdvancedMachineId: String(row.last_advanced_machine_id),
              revision: Number(row.stage_revision),
              createdAt: iso(row.stage_created_at),
              updatedAt: iso(row.stage_updated_at),
              holder: {
                id: String(row.last_advanced_machine_id),
                displayName: String(row.holder_display_name),
              },
            },
    }
  })
}
