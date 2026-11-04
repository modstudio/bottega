// concern: outside-write-adapter
/** Shared Postgres facts for writes made by signed-in users outside a space. */

import type { SQL } from 'bun'
import { type OutsideWriteDecision, outsideWriteDecision } from './outside-write-decision.ts'
import { recordSpaceAccessDecision } from './record-space-request.ts'

const rows = <T>(value: unknown) => value as T[]

export type OutsideIntake =
  | { kind: 'none' }
  | { kind: 'multiple'; refusal: string }
  | { kind: 'intake'; projectId: string; spaceId: string }

export async function resolveOutsideIntake(tx: SQL, project: string): Promise<OutsideIntake> {
  const matches = rows<{ project_id: string; space_id: string }>(
    await tx`SELECT project_id::text,space_id::text
      FROM public.outside_intake_for_project(${project})`,
  )
  if (matches.length > 1)
    return {
      kind: 'multiple',
      refusal: `more than one space takes outside posts for project '${project}'; ask its owner for the space`,
    }
  const intake = matches[0]
  return intake
    ? { kind: 'intake', projectId: intake.project_id, spaceId: intake.space_id }
    : { kind: 'none' }
}

export type OutsideAdmission =
  | { kind: 'outside' }
  | { kind: 'member' }
  | { kind: 'refused'; error: string; remedy: string }

export async function outsideAdmission(
  tx: SQL,
  userId: string,
  spaceId: string,
): Promise<OutsideAdmission> {
  const membership = rows<{ permission: string }>(
    await tx`SELECT permission FROM membership
      WHERE space_id=${spaceId}::uuid AND user_id=${userId}::uuid`,
  )[0]
  if (!membership) return { kind: 'outside' }
  if (membership.permission === 'write') return { kind: 'member' }
  const access = recordSpaceAccessDecision('write', spaceId, [
    { spaceId, slug: '', permission: membership.permission },
  ])
  return access.allowed
    ? { kind: 'member' }
    : { kind: 'refused', error: access.error, remedy: access.remedy }
}

export async function outsideWriteDecisionForUser(
  tx: SQL,
  input: {
    userId: string
    createdAt: string
    body: string
    area: string | null
    anchorLength: number
  },
): Promise<OutsideWriteDecision | null> {
  // Keep this key equal to the outside-write definers; all serialize one user's outside writes.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
  const user = rows<{ created_at: string; email_verified: boolean }>(
    await tx`SELECT created_at,email_verified FROM "user" WHERE id=${input.userId}::uuid`,
  )[0]
  if (!user) return null
  const window = rows<{
    hour_count: string
    day_count: string
    hour_oldest: string | null
    day_oldest: string | null
  }>(
    await tx`SELECT
      count(*) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 hour') AS hour_count,
      count(*) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 day') AS day_count,
      min(created_at) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 hour') AS hour_oldest,
      min(created_at) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 day') AS day_oldest
    FROM space_outside_write WHERE user_id=${input.userId}::uuid`,
  )[0]!
  return outsideWriteDecision({
    now: new Date(input.createdAt),
    createdAt: new Date(user.created_at),
    emailVerified: user.email_verified,
    body: input.body,
    area: input.area,
    anchorLength: input.anchorLength,
    writesLastHour: Number(window.hour_count),
    writesLastDay: Number(window.day_count),
    oldestWriteLastHour: window.hour_oldest ? new Date(window.hour_oldest) : null,
    oldestWriteLastDay: window.day_oldest ? new Date(window.day_oldest) : null,
  })
}
