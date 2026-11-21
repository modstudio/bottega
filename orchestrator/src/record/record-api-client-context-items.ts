// concern: record-api-client-context-items
/** Builds hosted context-item point-read methods and paths. */
import {
  CONTEXT_ITEM_HOLDER_BATCH_LIMIT,
  RECORD_CONTEXT_ITEM_HOLDERS_ROUTE,
  RECORD_CONTEXT_ITEMS_ROUTE,
} from '../../../shared/record-routes.ts'
import type {
  RecordClientRequest,
  RecordContextItemMethod,
  RecordRequestDestination,
  RecordWriteDestination,
} from './record-api-client-paths.ts'
import type { RecordContextItem, RecordContextItemInput } from './record-context-items.ts'

export type RecordContextItemClient = {
  listContextItems(
    holders: string[],
    destination: RecordRequestDestination,
  ): Promise<RecordContextItem[]>
  getContextItem(
    holder: string,
    slug: string,
    destination: RecordRequestDestination,
  ): Promise<RecordContextItem | null>
  listContextHolders(
    kind: 'task' | 'session' | 'cursor',
    destination: RecordRequestDestination,
  ): Promise<
    Array<{
      holder: string
      holderId: string
      updatedAt: string
      items: RecordContextItem[]
    }>
  >
  upsertContextItem(
    input: RecordContextItemInput,
    destination: RecordWriteDestination,
  ): Promise<{ id: string; createdAt: string; updatedAt: string }>
  deleteContextItem(
    id: string,
    input: { expectedRevision?: string },
    destination: RecordWriteDestination,
  ): Promise<{ removed: boolean }>
}

export function recordContextItemReadClient(
  request: RecordClientRequest,
): Pick<RecordContextItemClient, RecordContextItemMethod> {
  const itemPath = (holders: string[], slug?: string) => {
    const search = new URLSearchParams()
    for (const holder of holders) search.append('holder', holder)
    if (slug) search.set('slug', slug)
    return `${RECORD_CONTEXT_ITEMS_ROUTE}?${search}`
  }
  const itemChunks = (holders: string[]) => {
    const chunks: string[][] = []
    for (let index = 0; index < holders.length; index += CONTEXT_ITEM_HOLDER_BATCH_LIMIT)
      chunks.push(holders.slice(index, index + CONTEXT_ITEM_HOLDER_BATCH_LIMIT))
    if (chunks.length === 0) chunks.push([])
    return chunks
  }
  return {
    listContextItems: async (holders, destination) =>
      (
        await Promise.all(
          itemChunks(holders).map((chunk) =>
            request<RecordContextItem[]>(itemPath(chunk), destination),
          ),
        )
      ).flat(),
    getContextItem: async (holder, slug, destination) =>
      (await request<RecordContextItem[]>(itemPath([holder], slug), destination))[0] ?? null,
    listContextHolders: (kind, destination) =>
      request(`${RECORD_CONTEXT_ITEM_HOLDERS_ROUTE}?kind=${encodeURIComponent(kind)}`, destination),
    upsertContextItem: (input, destination) =>
      request(RECORD_CONTEXT_ITEMS_ROUTE, {
        method: 'PUT',
        body: JSON.stringify(input),
        ...destination,
      }),
    deleteContextItem: (id, input, destination) =>
      request(`${RECORD_CONTEXT_ITEMS_ROUTE}/${id}`, {
        method: 'DELETE',
        body: JSON.stringify(input),
        ...destination,
      }),
  }
}
