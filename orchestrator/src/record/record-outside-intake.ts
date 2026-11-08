// concern: record-outside-intake
/** Owns the active space's outside-intake project setting. */

import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { recordDate } from '../../../shared/record-timestamp.ts'
import { ConfigServiceError } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'

type Tenant = { url: string } & TenantPrincipal
export type OutsideIntake = {
  projectId: string
  project: string
  pausedUntil: string | null
  updatedAt: string
}

async function tenant<T>(input: Tenant, run: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return run(tx)
  })
}

export async function requireOwner(tx: SQL, input: Tenant, action: string): Promise<void> {
  const memberships = await tx`
    SELECT role FROM membership
    WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
  `
  if (memberships[0]?.role !== 'owner')
    throw new ConfigServiceError(
      `${action} requires the active space owner; switch to an owned space and retry`,
      403,
    )
}

function intakeFromRow(row: Record<string, unknown>): OutsideIntake {
  const pausedUntil = row.paused_until ? recordDate(row.paused_until) : null
  return {
    projectId: String(row.project_id),
    project: String(row.name),
    pausedUntil:
      pausedUntil && pausedUntil.getTime() > Date.now() ? pausedUntil.toISOString() : null,
    updatedAt: recordDate(row.updated_at).toISOString(),
  }
}

function noIntake(): ConfigServiceError {
  return new ConfigServiceError(
    `this space has no outside intake; set one with \`${PLATFORM_SLUG} record space intake set <project>\``,
    404,
  )
}

export async function showOutsideIntake(input: Tenant): Promise<OutsideIntake | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT i.project_id, p.name, i.paused_until, i.updated_at
      FROM space_outside_intake i JOIN project p ON p.id=i.project_id
      WHERE i.space_id=${input.spaceId}::uuid
    `
    const row = rows[0]
    return row ? intakeFromRow(row) : null
  })
}

export async function setOutsideIntake(
  input: Tenant & { project: string },
): Promise<OutsideIntake> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'setting the outside intake')
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
      pausedUntil: null,
      updatedAt: recordDate(rows[0].updated_at).toISOString(),
    }
  })
}

export async function pauseOutsideIntake(
  input: Tenant & { hours: number },
): Promise<OutsideIntake> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'pausing outside writes')
    const rows = await tx`
      UPDATE space_outside_intake i
      SET paused_until=now() + (${input.hours}::text || ' hours')::interval,
          paused_by_user_id=${input.userId}::uuid,
          updated_at=now()
      FROM project p
      WHERE i.space_id=${input.spaceId}::uuid AND p.id=i.project_id
      RETURNING i.project_id,p.name,i.paused_until,i.updated_at
    `
    if (!rows[0]) throw noIntake()
    return intakeFromRow(rows[0])
  })
}

export async function resumeOutsideIntake(input: Tenant): Promise<OutsideIntake> {
  return tenant(input, async (tx) => {
    await requireOwner(tx, input, 'resuming outside writes')
    const rows = await tx`
      UPDATE space_outside_intake i
      SET paused_until=NULL,paused_by_user_id=NULL,updated_at=now()
      FROM project p
      WHERE i.space_id=${input.spaceId}::uuid AND p.id=i.project_id
      RETURNING i.project_id,p.name,i.paused_until,i.updated_at
    `
    if (!rows[0]) throw noIntake()
    return intakeFromRow(rows[0])
  })
}
