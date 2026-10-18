import { userInfo } from 'node:os'
import { classifyCaller } from '../../shared/caller-classification.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { hostedSignedInUser } from './task-client.ts'

export type Attribution = {
  actorUserId: string | null
  actorName: string | null
  agent: string | null
  runId: string | null
}

export const NO_ATTRIBUTION: Attribution = {
  actorUserId: null,
  actorName: null,
  agent: null,
  runId: null,
}

export function mayChangeComment(
  recordedActorUserId: string | null,
  writerActorUserId: string | null,
): boolean {
  return writerActorUserId === null || recordedActorUserId === writerActorUserId
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

export async function cliAttribution(): Promise<Attribution> {
  const user = resolveHostedUrl() ? await hostedSignedInUser() : null
  return attributionFromInputs({ env: process.env, user, machineUser: userInfo().username })
}
