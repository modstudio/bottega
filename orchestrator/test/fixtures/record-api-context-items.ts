import { contextItemHolderGroup } from '../../../shared/context-item-vocabulary.ts'
import type { RecordApiClient } from '../../src/record/record-api-client.ts'
import type { RecordContextItem } from '../../src/record/record-context-items.ts'

export function memoryContextItemClient(
  contextItems: RecordContextItem[],
): Pick<RecordApiClient, 'listContextItems' | 'getContextItem' | 'listContextHolders'> {
  return {
    async listContextItems(holders) {
      return contextItems.filter((item) => holders.includes(item.holder))
    },
    async getContextItem(holder, slug) {
      return contextItems.find((item) => item.holder === holder && item.id === slug) ?? null
    },
    async listContextHolders(kind) {
      const selected = contextItems.filter((item) => item.holder.startsWith(`${kind}:`))
      return [...Map.groupBy(selected, (item) => item.holder)].map(([holder, items]) =>
        contextItemHolderGroup(holder, items),
      )
    },
  }
}
