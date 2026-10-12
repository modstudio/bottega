import { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import type { TaskIdentity } from './hosted-tasks.ts'
import {
  HUB_IDENTITY_SET_PAGE_SIZE,
  type IdentitySetPage,
  type IdentitySetRequest,
} from './identity-set-contract.ts'
import type { PushableHubChangeTable } from './push-contract.ts'

const SOFT_DELETED = new Set<string>([
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
])

const rows = <T>(value: unknown) => value as T[]

export async function readHostedIdentitySetInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: { table: PushableHubChangeTable; after: string | null; limit: number },
): Promise<IdentitySetPage> {
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
  input: IdentitySetRequest,
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
