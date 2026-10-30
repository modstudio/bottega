import { RECORD_SIGN_IN_REMEDY } from '../../shared/record-remedies.ts'
import {
  parseRecordSpaceMemberships,
  type RecordSpaceMembership,
} from '../../shared/record-space-membership.ts'
import { recordSpaceRequestDecision } from '../../shared/record-space-request.ts'

type RecordIdentity = {
  userId: string
  userName: string | null
  activeSpaceId: string
  memberships: RecordSpaceMembership[]
}

export type TaskSpaceIdentity =
  | ({ kind: 'authenticated'; spaceId: string; spaceIds: string[] } & Omit<
      RecordIdentity,
      'activeSpaceId'
    >)
  | { kind: 'refused-space'; refusedSpace: string }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable'; cause: string }

export function recordIdentityDecision(
  status: number,
  value: unknown,
):
  | { kind: 'authenticated'; identity: RecordIdentity }
  | Exclude<TaskSpaceIdentity, { kind: 'authenticated' | 'refused-space' }> {
  if (status === 401 || status === 403) return { kind: 'unauthenticated' }
  if (status < 200 || status >= 300) return { kind: 'unavailable', cause: String(status) }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { kind: 'unavailable', cause: String(status) }
  const object = value as Record<string, unknown>
  const user = object.user as Record<string, unknown> | undefined
  if (typeof user?.id !== 'string' || typeof object.activeSpaceId !== 'string')
    return { kind: 'unavailable', cause: String(status) }
  return {
    kind: 'authenticated',
    identity: {
      userId: user.id,
      userName: typeof user.name === 'string' && user.name.trim() ? user.name : null,
      activeSpaceId: object.activeSpaceId,
      memberships: parseRecordSpaceMemberships(object.memberships),
    },
  }
}

export function identityRefusalResponse(
  identity: Extract<TaskSpaceIdentity, { kind: 'unauthenticated' | 'unavailable' }>,
): Response {
  if (identity.kind === 'unauthenticated')
    return Response.json(
      { error: 'record session is missing or expired', remedy: RECORD_SIGN_IN_REMEDY },
      { status: 401 },
    )
  return Response.json(
    {
      error: `record API unavailable (${identity.cause})`,
      remedy: 'nothing was written; retry',
    },
    { status: 503 },
  )
}

export async function taskSpaceIdentity(
  request: Request,
  base: string,
  fetchImpl: typeof fetch,
  honorRequestedSpace: boolean,
): Promise<TaskSpaceIdentity> {
  const authorization = request.headers.get('authorization')
  if (!authorization) return { kind: 'unauthenticated' }
  let response: Response
  try {
    response = await fetchImpl(`${base.replace(/\/$/, '')}/v1/whoami`, {
      headers: { authorization },
    })
  } catch (cause) {
    return { kind: 'unavailable', cause: cause instanceof Error ? cause.name : 'Error' }
  }
  const identityDecision = recordIdentityDecision(
    response.status,
    await response.json().catch(() => null),
  )
  if (identityDecision.kind !== 'authenticated') return identityDecision
  const { identity } = identityDecision
  const decision = recordSpaceRequestDecision(
    honorRequestedSpace ? request.headers.get('x-record-space') : null,
    identity.activeSpaceId,
    identity.memberships,
  )
  if (!decision.allowed) return { kind: 'refused-space', refusedSpace: decision.requestedSpace }
  return {
    kind: 'authenticated',
    userId: identity.userId,
    userName: identity.userName,
    spaceId: decision.spaceId!,
    spaceIds: identity.memberships.map((row) => row.spaceId),
    memberships: identity.memberships,
  }
}
