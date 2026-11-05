// concern: record-api-doc-tenant
/** Resolves destination-less document requests without changing explicit destinations. */

import {
  type PersonalItemTarget,
  resolvePersonalItemSpace,
} from '../../../shared/personal-item-space.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordDoc } from './record-docs.ts'
import { RecordDocError } from './record-docs.ts'

export type RecordDocumentTenant = {
  url: string
  userId: string
  spaceId: string
  spaceIds: string[]
  personalSpaceId?: string | null
}

const identityOf = (identity: RecordIdentity) => ({
  userId: identity.user.id,
  activeSpaceId: identity.activeSpaceId,
  personalSpaceId: identity.personalSpaceId,
})

function tenantAt(input: RecordDocumentTenant, spaceId: string): RecordDocumentTenant {
  return { ...input, spaceId, spaceIds: [spaceId] }
}

export function recordDocumentTenant(
  tenant: RecordDocumentTenant,
  identity: RecordIdentity,
  explicitDestination: boolean,
  target: PersonalItemTarget,
): RecordDocumentTenant {
  if (explicitDestination) return tenant
  const spaceId = resolvePersonalItemSpace(identityOf(identity), target)
  if (!spaceId) throw new RecordDocError('personal space is not provisioned', 409)
  return spaceId === tenant.spaceId ? tenant : tenantAt(tenant, spaceId)
}

export async function recordDocumentIdTenant(
  tenant: RecordDocumentTenant,
  identity: RecordIdentity,
  explicitDestination: boolean,
  id: string,
  readDoc: (input: RecordDocumentTenant & { id: string }) => Promise<RecordDoc | null>,
): Promise<RecordDocumentTenant> {
  if (explicitDestination) return tenant
  const active = await readDoc({ ...tenantAt(tenant, tenant.spaceId), id })
  const personalSpaceId = identity.personalSpaceId
  const found =
    active ??
    (personalSpaceId && personalSpaceId !== tenant.spaceId
      ? await readDoc({ ...tenantAt(tenant, personalSpaceId), id })
      : null)
  if (!found) return tenant
  return recordDocumentTenant(tenant, identity, false, {
    kind: 'document',
    scope: found.scope,
    subject: found.subject,
    ownerUserId: found.owner,
  })
}
