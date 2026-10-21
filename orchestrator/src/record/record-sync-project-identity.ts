// concern: record-sync-project-identity
/** Resolves and caches hosted project UUIDs for one sync request. */
import type { SQL } from 'bun'
import { MISSING_PROJECT_ID_REMEDY } from '../../../shared/record-project-identity.ts'
import { OutboxRowError } from './outbox-failure.ts'
import { resolveRecordProjectIdentity } from './record-project-identity.ts'
import type { RecordPrincipal } from './record-sync-contract.ts'

export type ProjectResolutionCache = Map<string, string>

const nullableString = (value: unknown) => (value == null ? null : String(value))

export async function projectRecordId(
  tx: SQL,
  row: Record<string, unknown>,
  principal: RecordPrincipal,
  projectIds?: ProjectResolutionCache,
): Promise<string | null> {
  const requestedId = nullableString(row.projectId)
  const projectName = nullableString(row.projectName)
  if (requestedId === null && projectName === null) return null
  if (requestedId === null)
    throw new OutboxRowError(
      `project-scoped record write is missing projectId; ${MISSING_PROJECT_ID_REMEDY}`,
      'row-validation',
    )
  const cacheKey = `${principal.spaceId}:${requestedId}`
  const cached = projectIds?.get(cacheKey)
  if (cached !== undefined) return cached
  const resolved = await resolveRecordProjectIdentity(tx, {
    projectId: requestedId,
    projectName,
    spaceId: principal.spaceId,
  })
  if (resolved.status !== 'found') {
    throw new OutboxRowError(
      `record project ${requestedId} is absent from request space ${principal.spaceId}`,
      'row-validation',
    )
  }
  projectIds?.set(cacheKey, resolved.project.id)
  return resolved.project.id
}
