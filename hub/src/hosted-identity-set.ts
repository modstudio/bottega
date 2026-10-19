import type { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import type { TaskIdentity } from './hosted-tenant.ts'
import {
  HUB_IDENTITY_SET_PAGE_SIZE,
  type IdentitySetPage,
  type IdentitySetRequest,
} from './identity-set-contract.ts'
import {
  HOSTED_COMMENT_TABLE,
  HOSTED_DAY_TABLE,
  HOSTED_DOCUMENT_TABLE,
  HOSTED_INTERVAL_TABLE,
  HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
  HOSTED_NOTE_TABLE,
  HOSTED_STATUS_EVENT_TABLE,
  HOSTED_TASK_TABLE,
  type PushableHubChangeTable,
} from './push-contract.ts'

function hasSoftDelete(table: PushableHubChangeTable): boolean {
  switch (table) {
    case HOSTED_TASK_TABLE:
    case HOSTED_COMMENT_TABLE:
    case HOSTED_DOCUMENT_TABLE:
    case HOSTED_STATUS_EVENT_TABLE:
    case HOSTED_NOTE_TABLE:
    case HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE:
      return true
    case HOSTED_INTERVAL_TABLE:
    case HOSTED_DAY_TABLE:
      return false
    default:
      return assertNever(table)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled pushable hub table: ${value}`)
}

const rows = <T>(value: unknown) => value as T[]

export async function readHostedIdentitySetInTransaction(
  tx: SQL,
  identity: TaskIdentity,
  input: { table: PushableHubChangeTable; after: string | null; limit: number },
): Promise<IdentitySetPage> {
  const live = hasSoftDelete(input.table) ? 'AND deleted_at IS NULL' : ''
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
  client: SQL,
  identity: TaskIdentity,
  input: IdentitySetRequest,
) {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    await bindTenant(tx, identity)
    return readHostedIdentitySetInTransaction(tx, identity, {
      ...input,
      limit: HUB_IDENTITY_SET_PAGE_SIZE,
    })
  })
}
