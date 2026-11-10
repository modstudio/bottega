// concern: record-api-client-session
/** Builds hosted session identity and evidence-sync requests. */

import {
  NO_DESTINATION_WRITES_ROUTE,
  type NoDestinationWriteReport,
  parseNoDestinationWriteReport,
} from '../../../shared/record-no-destination-write-contract.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import { responseRecord } from './record-api-client-response.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordSyncRequest, RecordSyncResponse } from './record-sync-contract.ts'

export type RecordSessionClient = {
  noDestinationWrites?(): Promise<NoDestinationWriteReport>
  whoami(): Promise<RecordIdentity>
  sync?(input: RecordSyncRequest): Promise<RecordSyncResponse>
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
      request(NO_DESTINATION_WRITES_ROUTE, {
        schema: (body) => parseNoDestinationWriteReport(body, 'record API'),
      }),
    whoami: () => request('/v1/whoami', { schema: identitySchema }),
    sync: (input) => request('/v1/sync', { method: 'POST', body: JSON.stringify(input) }),
  }
}
