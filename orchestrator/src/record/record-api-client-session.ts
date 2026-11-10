// concern: record-api-client-session
/** Builds hosted session identity and evidence-sync requests. */

import type { RecordClientRequest } from './record-api-client-paths.ts'
import { responseRecord } from './record-api-client-response.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  NO_DESTINATION_WRITES_ROUTE,
  type NoDestinationWriteReport,
} from './record-no-destination-write-contract.ts'
import type { RecordSyncRequest, RecordSyncResponse } from './record-sync-contract.ts'

export type RecordSessionClient = {
  noDestinationWrites?(): Promise<NoDestinationWriteReport>
  whoami(): Promise<RecordIdentity>
  sync?(input: RecordSyncRequest): Promise<RecordSyncResponse>
}

function noDestinationWriteResponse(body: unknown): NoDestinationWriteReport {
  const value = responseRecord(body)
  if (typeof value.processStartedAt !== 'string' || !Array.isArray(value.counts))
    throw new Error('record API returned invalid destination-less write counts')
  const counts = value.counts.map((input) => {
    const row = responseRecord(input)
    if (
      typeof row.spaceId !== 'string' ||
      typeof row.route !== 'string' ||
      typeof row.cause !== 'string' ||
      !Number.isInteger(row.occurrences)
    )
      throw new Error('record API returned invalid destination-less write counts')
    return row as NoDestinationWriteReport['counts'][number]
  })
  return { processStartedAt: value.processStartedAt, counts }
}

export function recordIdentityResponse(
  body: unknown,
  invalid: (message: string) => Error = (message) => new Error(message),
): RecordIdentity {
  const value = responseRecord(body)
  const user = responseRecord(value.user)
  const memberships = Array.isArray(value.memberships)
    ? value.memberships.map((membership) => responseRecord(membership))
    : null
  if (
    !['id', 'email'].every((field) => typeof user[field] === 'string') ||
    typeof user.emailVerified !== 'boolean' ||
    (value.activeSpaceId !== null && typeof value.activeSpaceId !== 'string') ||
    (value.personalSpaceId !== null && typeof value.personalSpaceId !== 'string') ||
    !memberships ||
    memberships.some((membership) =>
      ['space_id', 'name', 'slug', 'role', 'permission'].some(
        (field) => typeof membership[field] !== 'string',
      ),
    )
  )
    throw invalid('record API returned an invalid identity')
  return {
    user: user as RecordIdentity['user'],
    activeSpaceId: value.activeSpaceId,
    personalSpaceId: value.personalSpaceId,
    memberships,
  }
}

export function recordSessionClient(
  request: RecordClientRequest,
  identitySchema: (body: unknown) => RecordIdentity,
): RecordSessionClient {
  return {
    noDestinationWrites: () =>
      request(NO_DESTINATION_WRITES_ROUTE, { schema: noDestinationWriteResponse }),
    whoami: () => request('/v1/whoami', { schema: identitySchema }),
    sync: (input) => request('/v1/sync', { method: 'POST', body: JSON.stringify(input) }),
  }
}
