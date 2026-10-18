import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { classifyCaller } from '../../shared/caller-classification.ts'
import type { TaskWriteMode } from './task-write-destination.ts'

export type Attribution = {
  actorUserId: string | null
  actorName: string | null
  agent: string | null
  runId: string | null
}

export const UNATTRIBUTED: Attribution = {
  actorUserId: null,
  actorName: null,
  agent: null,
  runId: null,
}

export type CommentAuthorDecision = { allowed: true } | { allowed: false; reason: string }

export function commentAuthorDecision(
  mode: TaskWriteMode,
  writerActorUserId: string | null,
  recordedActorUserId: string | null,
): CommentAuthorDecision {
  if (mode === 'local-authoritative') return { allowed: true }
  if (writerActorUserId === null)
    return {
      allowed: false,
      reason: `record identity could not be resolved; run \`${PLATFORM_SLUG} record sign-in\` and retry`,
    }
  if (recordedActorUserId === null)
    return {
      allowed: false,
      reason:
        'predates recorded authorship and cannot be changed from a record-bound session; add a new comment instead',
    }
  if (recordedActorUserId !== writerActorUserId)
    return { allowed: false, reason: 'belongs to another author; ask its author to change it' }
  return { allowed: true }
}

export function attributionFromInputs(input: {
  env: Record<string, string | undefined>
  user: { id: string; name: string | null } | null
  machineUser: string
}): Attribution {
  const runId = input.env.ORCH_RUN_ID?.trim() || null
  const caller = classifyCaller(input.env)
  return {
    actorUserId: input.user?.id ?? null,
    actorName: input.user?.name ?? input.machineUser,
    agent:
      (runId ? input.env.ORCH_AGENT?.trim() : null) ||
      (caller.kind === 'harness' ? caller.harness : null),
    runId,
  }
}
