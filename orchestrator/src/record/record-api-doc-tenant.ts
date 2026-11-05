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

type RecordDocumentContext = {
  get(key: 'identity'): RecordIdentity
  get(key: 'destinationSpaceId'): string | undefined
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

export function recordDocumentScopes<Context extends RecordDocumentContext>(input: {
  scope(context: Context): RecordDocumentTenant | null
  readDoc(input: RecordDocumentTenant & { id: string }): Promise<RecordDoc | null>
}) {
  const docScope = (context: Context, target: PersonalItemTarget) => {
    const tenant = input.scope(context)
    return tenant
      ? recordDocumentTenant(
          tenant,
          context.get('identity'),
          context.get('destinationSpaceId') !== undefined,
          target,
        )
      : null
  }
  const docIdScope = async (context: Context, id: string) => {
    const tenant = input.scope(context)
    return tenant
      ? recordDocumentIdTenant(
          tenant,
          context.get('identity'),
          context.get('destinationSpaceId') !== undefined,
          id,
          input.readDoc,
        )
      : null
  }
  return { docScope, docIdScope }
}
