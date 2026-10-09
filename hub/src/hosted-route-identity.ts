import { parseRecordSpaceMemberships } from '../../shared/record-space-membership.ts'
import { recordSpaceRequestDecision } from '../../shared/record-space-request.ts'

export async function taskSpaceIdentity(
  request: Request,
  base: string,
  fetchImpl: typeof fetch,
  honorRequestedSpace: boolean,
) {
  const authorization = request.headers.get('authorization')
  if (!authorization) return null
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/v1/whoami`, {
    headers: { authorization },
  })
  if (!response.ok) return null
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const user = value?.user as Record<string, unknown> | undefined
  const memberships = parseRecordSpaceMemberships(value?.memberships)
  if (typeof user?.id !== 'string' || typeof value?.activeSpaceId !== 'string') return null
  const decision = recordSpaceRequestDecision(
    honorRequestedSpace ? request.headers.get('x-record-space') : null,
    value.activeSpaceId,
    memberships,
  )
  if (!decision.allowed) return { refusedSpace: decision.requestedSpace }
  return {
    userId: user.id,
    spaceId: decision.spaceId!,
    spaceIds: memberships.map((row) => row.spaceId),
    memberships,
  }
}
