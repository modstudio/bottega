// concern: record-api-tenant
/** Builds the server-owned tenant used by hosted API routes. */

import type { WriteSpaceRefusal } from '../../../shared/record-remedies.ts'
import type { RecordDocumentTenant } from './record-api-doc-tenant.ts'
import type { RecordIdentity } from './record-auth.ts'

export type RequestTenant = RecordDocumentTenant | WriteSpaceRefusal | null

export function requestTenant(
  identity: RecordIdentity,
  destinationSpaceId: string | undefined,
  nature: 'read' | 'write',
  url: string,
): RequestTenant {
  if (nature === 'write' && destinationSpaceId === undefined)
    return { refused: 'write-destination' }
  if (!identity.activeSpaceId) return null
  const memberships = identity.memberships.map((row) => String(row.space_id))
  return {
    url,
    userId: identity.user.id,
    personalSpaceId: identity.personalSpaceId,
    spaceId: destinationSpaceId ?? identity.activeSpaceId,
    spaceIds:
      destinationSpaceId != null
        ? [destinationSpaceId]
        : identity.activeSpaceId === identity.personalSpaceId
          ? memberships
          : [identity.activeSpaceId],
  }
}
