// concern: record-board-tx
/** Tenant-bound hosted board transactions. Must not know HTTP or local stores. */

import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { BOARD_MESSAGE_REVISION_LOCK_KEY, RecordBoardError } from './record-board-contract.ts'

export type BoardTenant = { url: string } & TenantPrincipal

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = 'cause' in current ? current.cause : null
  }
  return chain
}

function postgresSqlState(error: unknown): string | null {
  for (const item of errorChain(error)) {
    const candidate = item as { code?: unknown; errno?: unknown }
    for (const value of [candidate.errno, candidate.code]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      const normalized = String(value).toUpperCase()
      if (/^[0-9A-Z]{5}$/.test(normalized)) return normalized
    }
  }
  return null
}

function postgresServerMessage(error: unknown): string {
  for (const item of errorChain(error)) {
    const candidate = item as { code?: unknown }
    if (candidate.code === 'ERR_POSTGRES_SERVER_ERROR' && item instanceof Error) return item.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Maps a board trigger exception or RLS denial to a named refusal. */
export function hostedBoardStoreRefusal(error: unknown): RecordBoardError | null {
  if (error instanceof RecordBoardError) return error
  const state = postgresSqlState(error)
  const message = postgresServerMessage(error)
  if (state === 'P0001') return new RecordBoardError(message, 400)
  if (state === '42501' && message.includes('row-level security')) {
    return new RecordBoardError(message, 400)
  }
  return null
}

export async function withBoardTenant<T>(
  input: BoardTenant,
  lockMessages: boolean,
  read: (tx: SQL) => Promise<T>,
): Promise<T> {
  const client = new SQL(input.url)
  try {
    try {
      return await client.begin(async (tx) => {
        await bindTenant(tx, input)
        if (lockMessages) await tx`SELECT pg_advisory_xact_lock(${BOARD_MESSAGE_REVISION_LOCK_KEY})`
        return read(tx)
      })
    } catch (error) {
      throw hostedBoardStoreRefusal(error) ?? error
    }
  } finally {
    await client.close()
  }
}

export function boardUuidArray(tx: SQL, ids: readonly string[]) {
  return tx.array([...ids], 'uuid')
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
