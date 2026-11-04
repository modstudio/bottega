// concern: record-outside-write
/** Reads outside-write facts and invokes the only database insertion boundary. */

import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'
import { RecordBoardError } from './record-board-contract.ts'
import { outsideWriteDecision } from './record-outside-write-decision.ts'

export async function hasProjectWriteMembership(
  tx: SQL,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM project p JOIN membership m ON m.space_id=p.space_id
    WHERE p.id=${projectId}::uuid AND m.user_id=${userId}::uuid AND m.permission='write'
  `
  return Boolean(rows[0])
}

export async function isOutsideIntakeProject(tx: SQL, projectId: string): Promise<boolean> {
  const rows = await tx`
    SELECT public.project_is_outside_intake(${projectId}::uuid) AS is_intake
  `
  return rows[0]?.is_intake === true
}

export async function insertOutsideBoardMessage(
  tx: SQL,
  input: {
    id: string
    userId: string
    authorSession: string | null
    authorHarness?: string | null
    authorMachineId?: string | null
    authorRunId?: string | null
    authorProjectId: string | null
    kind: 'notice' | 'question' | 'reply'
    purpose: string | null
    threadRootId: string | null
    audience: string | null
    title: string | null
    body: string
    ackRequired: boolean
    ackDeadline: string | null
    expiresAt: string | null
    projectId: string
    createdAt: string
  },
): Promise<void> {
  // Keep this key equal to board_message_insert_outside in migration
  // 20261104032550_dev_2087_outside_board_definer; both serialize one user's outside writes.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
  const users = await tx`
    SELECT created_at,email_verified FROM "user" WHERE id=${input.userId}::uuid
  `
  const windows = await tx`
    SELECT
      count(*) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 hour') AS hour_count,
      count(*) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 day') AS day_count,
      min(created_at) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 hour') AS hour_oldest,
      min(created_at) FILTER (WHERE created_at >= ${input.createdAt}::timestamptz - interval '1 day') AS day_oldest
    FROM space_outside_write WHERE user_id=${input.userId}::uuid
  `
  const user = users[0]
  if (!user) throw new RecordBoardError('signed-in board user no longer exists; sign in again', 403)
  const counts = windows[0]!
  const decision = outsideWriteDecision({
    now: new Date(input.createdAt),
    createdAt: new Date(String(user.created_at)),
    emailVerified: user.email_verified === true,
    body: input.body,
    writesLastHour: Number(counts.hour_count),
    writesLastDay: Number(counts.day_count),
    oldestWriteLastHour: counts.hour_oldest ? new Date(String(counts.hour_oldest)) : null,
    oldestWriteLastDay: counts.day_oldest ? new Date(String(counts.day_oldest)) : null,
  })
  if (!decision.allowed) throw new RecordBoardError(decision.refusal, decision.status)
  await tx`
    SELECT public.board_message_insert_outside(
      ${input.id}::uuid, ${newRecordId()}::uuid, ${input.userId}::uuid,
      ${input.authorSession}, ${input.authorHarness ?? null}, ${input.authorMachineId ?? null}::uuid,
      ${input.authorRunId ?? null}::uuid, ${input.authorProjectId}::uuid, ${input.kind},
      ${input.purpose}, ${input.threadRootId}::uuid, ${input.audience}, ${input.title}, ${input.body},
      ${input.ackRequired}, ${input.ackDeadline}::timestamptz, ${input.expiresAt}::timestamptz,
      ${input.createdAt}::timestamptz, ${input.projectId}::uuid
    )
  `
}
