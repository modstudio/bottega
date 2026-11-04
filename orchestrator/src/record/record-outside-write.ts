// concern: record-outside-write
/** Reads outside-write facts and invokes the only database insertion boundary. */

import type { SQL } from 'bun'
import { outsideWriteDecisionForUser } from '../../../shared/outside-write-adapter.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { RecordBoardError } from './record-board-contract.ts'

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
  const decision = await outsideWriteDecisionForUser(tx, {
    userId: input.userId,
    createdAt: input.createdAt,
    body: input.body,
    area: null,
    anchorLength: 0,
  })
  if (!decision)
    throw new RecordBoardError('signed-in board user no longer exists; sign in again', 403)
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
