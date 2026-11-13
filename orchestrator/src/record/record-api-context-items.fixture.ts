import type { RecordApiClient } from './record-api-client.ts'

function unusedContextItem(): Promise<never> {
  return Promise.reject(new Error('hosted context items are unused in this fixture'))
}

export function unusedContextItemClientMethods(): Pick<
  RecordApiClient,
  'upsertContextItem' | 'deleteContextItem'
> {
  return {
    upsertContextItem: unusedContextItem,
    deleteContextItem: unusedContextItem,
  }
}
