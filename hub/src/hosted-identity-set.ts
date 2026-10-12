import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import type { TaskIdentity } from './hosted-tasks.ts'
import {
  PUSHABLE_HUB_CHANGE_TABLES,
  type PushableHubChangeTable,
} from './push-contract.ts'

export const HUB_IDENTITY_SET_PAGE_SIZE = 5000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOFT_DELETED = new Set<string>([
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
])

const rows = <T>(value: unknown) => value as T[]

export function parseIdentitySetTable(value: string | null): PushableHubChangeTable {
  if (!value || !PUSHABLE_HUB_CHANGE_TABLES.includes(value as PushableHubChangeTable))
    throw new Error(`table must name one of: ${PUSHABLE_HUB_CHANGE_TABLES.join(', ')}`)
  return value as PushableHubChangeTable
}

export function identitySetRequestInput(url: URL): {
  table: PushableHubChangeTable
  after: string | null
} {
  const table = parseIdentitySetTable(url.searchParams.get('table'))
  const after = url.searchParams.get('after')
  if (after === null) return { table, after: null }
  if (!UUID.test(after)) throw new Error('after must be a UUID')
  return { table, after }
}

export async function readHostedIdentitySetInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: { table: PushableHubChangeTable; after: string | null; limit: number },
): Promise<{ ids: string[]; more: boolean }> {
  const live = SOFT_DELETED.has(input.table) ? 'AND deleted_at IS NULL' : ''
  const selected = rows<{ id: string }>(
    await tx`SELECT id::text AS id FROM ${tx.unsafe(input.table)}
      WHERE space_id=${identity.spaceId}::uuid ${tx.unsafe(live)}
        AND (${input.after}::text IS NULL OR id>${input.after}::uuid)
      ORDER BY id LIMIT ${input.limit + 1}`,
  )
  return {
    ids: selected.slice(0, input.limit).map((row) => row.id),
    more: selected.length > input.limit,
  }
}

export async function listHostedIdentitySet(
  url: string,
  identity: TaskIdentity,
  input: { table: PushableHubChangeTable; after: string | null },
) {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      await bindTenant(tx, identity)
      return readHostedIdentitySetInTransaction(tx, identity, {
        ...input,
        limit: HUB_IDENTITY_SET_PAGE_SIZE,
      })
    })
  } finally {
    await client.close()
  }
}
