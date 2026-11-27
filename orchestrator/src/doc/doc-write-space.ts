// concern: document-write-space
/** Resolves an optional CLI/MCP space slug to the signed-in user's write destination. */

import { parseRecordSpaceMemberships } from '../../../shared/record-space-membership.ts'
import { resolveRecordSpaceOwnerDestination } from '../../../shared/record-space-owner-destination.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type { DocWriteSpace, DocWriteTarget } from './doc-authoritative-read.ts'

export async function resolveDocWriteSpace(
  verb: string,
  requested: string | undefined,
): Promise<DocWriteSpace | undefined> {
  if (requested === undefined) return undefined
  const client = recordApiClient()
  const destination = await resolveRecordSpaceOwnerDestination(
    verb,
    { space: requested },
    [],
    async () => parseRecordSpaceMemberships((await client.whoami()).memberships),
  )
  return { spaceId: destination.spaceId, slug: destination.slug }
}

export function hostedDocWriteDestination(target: DocWriteTarget, address: string) {
  if (target.doc && !target.spaceId)
    throw new Error(`refusing hosted write for ${address}: the read target names no space`)
  return target.spaceId
}
