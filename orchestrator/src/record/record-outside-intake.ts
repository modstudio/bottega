// concern: record-outside-intake
/** Owns the active space's outside-intake project setting. */

import type { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'

type Tenant = { url: string } & TenantPrincipal
export type OutsideIntake = { projectId: string; project: string; updatedAt: string }

async function tenant<T>(input: Tenant, run: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return run(tx)
  })
}

export async function showOutsideIntake(input: Tenant): Promise<OutsideIntake | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT i.project_id, p.name, i.updated_at
      FROM space_outside_intake i JOIN project p ON p.id=i.project_id
      WHERE i.space_id=${input.spaceId}::uuid
    `
    const row = rows[0]
    return row
      ? {
          projectId: String(row.project_id),
          project: String(row.name),
          updatedAt: new Date(String(row.updated_at)).toISOString(),
        }
      : null
  })
}

export async function setOutsideIntake(
  input: Tenant & { project: string },
): Promise<OutsideIntake> {
  return tenant(input, async (tx) => {
    const memberships = await tx`
      SELECT role FROM membership
      WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
    `
    if (memberships[0]?.role !== 'owner')
      throw new ConfigServiceError(
        'setting the outside intake requires the active space owner; switch to an owned space and retry',
        403,
      )
    const projects = await tx`
      SELECT id FROM project WHERE space_id=${input.spaceId}::uuid AND name=${input.project}
    `
    const projectId = projects[0]?.id
    if (!projectId)
      throw new ConfigServiceError(
        `project ${input.project} is outside the active record space; choose a project from the active space`,
        404,
      )
    const rows = await tx`
      INSERT INTO space_outside_intake
        (id,space_id,project_id,paused_until,paused_by_user_id,updated_at)
      VALUES (${newRecordId()}::uuid,${input.spaceId}::uuid,${String(projectId)}::uuid,NULL,NULL,now())
      ON CONFLICT (space_id) DO UPDATE
      SET project_id=EXCLUDED.project_id, paused_until=NULL, paused_by_user_id=NULL, updated_at=now()
      RETURNING updated_at
    `
    return {
      projectId: String(projectId),
      project: input.project,
      updatedAt: new Date(String(rows[0].updated_at)).toISOString(),
    }
  })
}
