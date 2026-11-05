// concern: record-api-doc-tenant
/** Resolves destination-less document requests without changing explicit destinations. */

import {
  type PersonalItemTarget,
  resolvePersonalItemSpace,
} from '../../../shared/personal-item-space.ts'
import type { RecordIdentity } from './record-auth.ts'
import type { RecordDoc } from './record-docs.ts'
import { RecordDocError } from './record-docs.ts'
import type { RecordSettingsTenant } from './record-settings.ts'

export type RecordDocumentTenant = RecordSettingsTenant

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

function recordDocumentTenant(
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

/** An id names one row, so the operation binds to the space that holds it. */
async function recordDocumentIdTenant(
  tenant: RecordDocumentTenant,
  identity: RecordIdentity,
  explicitDestination: boolean,
  id: string,
  readDoc: (input: RecordDocumentTenant & { id: string }) => Promise<RecordDoc | null>,
): Promise<RecordDocumentTenant> {
  if (explicitDestination) return tenant
  if (await readDoc({ ...tenantAt(tenant, tenant.spaceId), id })) return tenant
  const personalSpaceId = identity.personalSpaceId
  if (!personalSpaceId || personalSpaceId === tenant.spaceId) return tenant
  const personal = tenantAt(tenant, personalSpaceId)
  return (await readDoc({ ...personal, id })) ? personal : tenant
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
