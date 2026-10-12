import { hasRecordIdShape } from '../../shared/record-id.ts'
import { PUSHABLE_HUB_CHANGE_TABLES, type PushableHubChangeTable } from './push-contract.ts'

export const HUB_IDENTITY_SET_PAGE_SIZE = 5000

export type IdentitySetRequest = {
  table: PushableHubChangeTable
  after: string | null
}

export type IdentitySetPage = {
  ids: string[]
  more: boolean
}

export function parseIdentitySetTable(value: string | null): PushableHubChangeTable {
  if (!value || !PUSHABLE_HUB_CHANGE_TABLES.includes(value as PushableHubChangeTable))
    throw new Error(`table must name one of: ${PUSHABLE_HUB_CHANGE_TABLES.join(', ')}`)
  return value as PushableHubChangeTable
}

export function parseIdentitySetRequest(url: URL): IdentitySetRequest {
  const table = parseIdentitySetTable(url.searchParams.get('table'))
  const after = url.searchParams.get('after')
  if (after === null) return { table, after: null }
  if (!hasRecordIdShape(after)) throw new Error('after must be a UUID')
  return { table, after }
}

function identitySetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !hasRecordIdShape(id)))
    throw new Error('hosted hub returned a malformed identity set: ids must be UUIDs')
  return value
}

export function parseIdentitySetPage(value: unknown): IdentitySetPage {
  const page = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!page) throw new Error('hosted hub returned a malformed identity set: ids must be UUIDs')
  const ids = identitySetIds((page as { ids?: unknown }).ids)
  const more = (page as { more?: unknown }).more
  if (typeof more !== 'boolean')
    throw new Error('hosted hub returned a malformed identity set: more must be a boolean')
  if (more && ids.length === 0)
    throw new Error('hosted hub returned a malformed identity set: more is true with no ids')
  if (more && ids.length < HUB_IDENTITY_SET_PAGE_SIZE)
    throw new Error(
      `hosted hub returned a malformed identity set: more is true below page size ${HUB_IDENTITY_SET_PAGE_SIZE}`,
    )
  return { ids, more }
}
