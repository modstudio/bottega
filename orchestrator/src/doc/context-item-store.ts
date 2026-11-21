// concern: context-item-store
/** Selects the authoritative context-item reader while retaining local-only persistence. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type {
  ContextHolderKind,
  ContextItemHolderGroup,
  StoredContextItem,
} from '../../../shared/context-item-vocabulary.ts'
import { db } from '../database/db.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import type { RecordWriteDecision } from '../record/record-write-decision.ts'
import { hostedContextItemDestination } from './context-item-hosted-client.ts'
import {
  getLocalContextItem,
  listLocalContextHolders,
  listLocalContextItems,
  removeLocalContextHolder,
  removeLocalContextItem,
  setLocalContextItem,
} from './context-item-store-sqlite.ts'

export type { StoredContextItem } from '../../../shared/context-item-vocabulary.ts'
export { removeLocalContextHolder, removeLocalContextItem, setLocalContextItem }

type ContextItemReadSource = 'local' | 'hosted'

/** Pure install-mode decision for the context-item read boundary. */
export function contextItemReadSource(decision: RecordWriteDecision): ContextItemReadSource {
  throwIfRecordRefused(decision)
  return decision.verdict === 'hosted' ? 'hosted' : 'local'
}

export function contextItemReadSourceFor(database: Database = db()): ContextItemReadSource {
  return contextItemReadSource(currentRecordWriteDecision(database))
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
  if (holders.length === 0) return []
  if (contextItemReadSourceFor(database) === 'local')
    return holders.flatMap((value) => listLocalContextItems(value, database))
  try {
    const client = recordApiClient()
    const groups = new Map<string, { destinationSpaceId: string; holders: string[] }>()
    for (const value of holders) {
      const destination = await hostedContextItemDestination(value)
      const group = groups.get(destination.destinationSpaceId)
      if (group) group.holders.push(value)
      else groups.set(destination.destinationSpaceId, { ...destination, holders: [value] })
    }
    const items = (
      await Promise.all(
        [...groups.values()].map(({ holders: groupedHolders, ...destination }) =>
          client.listContextItems(groupedHolders, destination),
        ),
      )
    ).flat()
    const holderOrder = new Map(holders.map((value, index) => [value, index]))
    return items.sort(
      (left, right) =>
        (holderOrder.get(left.holder) ?? holders.length) -
        (holderOrder.get(right.holder) ?? holders.length),
    )
  } catch (error) {
    return contextItemReadFailure(error)
  }
}

export async function getContextItem(
  holder: string,
  slug: string,
  database: Database = db(),
): Promise<StoredContextItem | null> {
  if (contextItemReadSourceFor(database) === 'local')
    return getLocalContextItem(holder, slug, database)
  try {
    const destination = await hostedContextItemDestination(holder)
    return await recordApiClient().getContextItem(holder, slug, destination)
  } catch (error) {
    return contextItemReadFailure(error)
  }
}

export async function listContextHolders(
  holderKind: ContextHolderKind,
  database: Database = db(),
): Promise<ContextItemHolderGroup[]> {
  if (contextItemReadSourceFor(database) === 'local')
    return listLocalContextHolders(holderKind, database)
  try {
    const destination = await hostedContextItemDestination('session:context-holder-catalogue')
    return await recordApiClient().listContextHolders(holderKind, destination)
  } catch (error) {
    return contextItemReadFailure(error)
  }
}
