// concern: context-item-store
/** Selects the authoritative context-item reader while retaining local-only persistence. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ContextHolderKind } from '../../../shared/context-item-vocabulary.ts'
import { db } from '../database/db.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import type { RecordWriteDecision } from '../record/record-write-decision.ts'
import {
  getLocalContextItem,
  listLocalContextHolders,
  listLocalContextItems,
  removeLocalContextHolder,
  removeLocalContextItem,
  type StoredContextItem,
  setLocalContextItem,
} from './context-item-store-sqlite.ts'

export type { StoredContextItem }
export { removeLocalContextHolder, removeLocalContextItem, setLocalContextItem }

type ContextItemReadSource = 'local' | 'hosted'

/** Pure install-mode decision for the context-item read boundary. */
export function contextItemReadSource(decision: RecordWriteDecision): ContextItemReadSource {
  throwIfRecordRefused(decision)
  return decision.verdict === 'hosted' ? 'hosted' : 'local'
}

export function contextItemReadFailure(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error)
  throw new Error(
    `hosted context items could not be read (${detail})\n` +
      `remedy: run \`${PLATFORM_SLUG} record doctor\`, update a server missing the context-item read routes, then retry`,
  )
}

export async function listContextItems(
  holder: string | readonly string[],
  database: Database = db(),
): Promise<StoredContextItem[]> {
  const holders = typeof holder === 'string' ? [holder] : [...holder]
  if (contextItemReadSource(currentRecordWriteDecision(database)) === 'local')
    return holders.flatMap((value) => listLocalContextItems(value, database))
  try {
    return await recordApiClient().listContextItems(holders, {})
  } catch (error) {
    return contextItemReadFailure(error)
  }
}

export async function getContextItem(
  holder: string,
  slug: string,
  database: Database = db(),
): Promise<StoredContextItem | null> {
  if (contextItemReadSource(currentRecordWriteDecision(database)) === 'local')
    return getLocalContextItem(holder, slug, database)
  try {
    return await recordApiClient().getContextItem(holder, slug, {})
  } catch (error) {
    return contextItemReadFailure(error)
  }
}

export async function listContextHolders(holderKind: ContextHolderKind, database: Database = db()) {
  if (contextItemReadSource(currentRecordWriteDecision(database)) === 'local')
    return listLocalContextHolders(holderKind, database)
  try {
    return await recordApiClient().listContextHolders(holderKind, {})
  } catch (error) {
    return contextItemReadFailure(error)
  }
}
