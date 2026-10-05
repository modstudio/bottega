// concern: record-board-tx
/** Tenant-bound hosted board transactions. Must not know HTTP or local stores. */

import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { BOARD_MESSAGE_REVISION_LOCK_KEY } from './record-board-contract.ts'

export type BoardTenant = { url: string } & TenantPrincipal

export async function withBoardTenant<T>(
  input: BoardTenant,
  lockMessages: boolean,
  read: (tx: SQL) => Promise<T>,
): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      if (lockMessages) await tx`SELECT pg_advisory_xact_lock(${BOARD_MESSAGE_REVISION_LOCK_KEY})`
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export function uuidListSql(ids: readonly string[]): string {
  return ids.join(',')
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== 'object') return false
  const postgres = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown }
  const message = error instanceof Error ? error.message : String(error)
  const named =
    postgres.constraint === constraint ||
    postgres.constraint_name === constraint ||
    message.includes(`"${constraint}"`) ||
    message.includes(constraint)
  return named && (postgres.code === '23505' || message.includes('duplicate key value'))
}

export function isRowLevelRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('row-level security') || message.includes('board claim')
}
