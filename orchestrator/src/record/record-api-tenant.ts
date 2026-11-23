// concern: record-api-tenant
/** Builds the server-owned tenant used by hosted API routes. */

import type {
  CrossSpaceDestinationRefusal,
  WriteSpaceRefusal,
} from '../../../shared/record-remedies.ts'
import type { RecordDocumentTenant } from './record-api-doc-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'
import { recordReadIsUuidKeyed } from './record-keyed-read.ts'

export type RequestTenant =
  | (RecordDocumentTenant & { uuidKeyedRead?: true })
  | WriteSpaceRefusal
  | CrossSpaceDestinationRefusal
  | null

export function requestTenant(
  identity: RecordIdentity,
  destinationSpaceId: string | undefined,
  nature: 'read' | 'write',
  url: string,
  route: string,
  readKind?: string,
  acrossReadableSpaces = false,
): RequestTenant {
  if (nature === 'write' && destinationSpaceId === undefined)
    return { refused: 'write-destination' }
  if (acrossReadableSpaces && destinationSpaceId !== undefined)
    return { refused: 'cross-space-destination' }
  if (!identity.activeSpaceId) return null
  const memberships = identity.memberships.map((row) => String(row.space_id))
  const uuidKeyedRead = destinationSpaceId === undefined && recordReadIsUuidKeyed(route, readKind)
  return {
    url,
    userId: identity.user.id,
    personalSpaceId: identity.personalSpaceId,
    spaceId: destinationSpaceId ?? identity.activeSpaceId,
    spaceIds: acrossReadableSpaces
      ? memberships
      : destinationSpaceId != null
        ? [destinationSpaceId]
        : uuidKeyedRead || identity.activeSpaceId === identity.personalSpaceId
          ? memberships
          : [identity.activeSpaceId],
    ...(uuidKeyedRead ? { uuidKeyedRead: true as const } : {}),
  }
}
