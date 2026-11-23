import type { RecordApiClient } from './record-api-client.ts'

function unusedContextItem(): Promise<never> {
  return Promise.reject(new Error('hosted context items are unused in this fixture'))
}

export function unusedContextItemClientMethods(): Pick<
  RecordApiClient,
  | 'listContextItems'
  | 'getContextItem'
  | 'listContextHolders'
  | 'upsertContextItem'
  | 'deleteContextItem'
> {
  return {
    listContextItems: unusedContextItem,
    getContextItem: unusedContextItem,
    listContextHolders: unusedContextItem,
    upsertContextItem: unusedContextItem,
    deleteContextItem: unusedContextItem,
  }
}
