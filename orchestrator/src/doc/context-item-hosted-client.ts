// concern: context-item-hosted-client
/** Binds hosted context-item writes to the holder's record destination. */
import type { RecordWriteOwner } from '../../../shared/record-write-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'
import { contextItemOwner } from './doc-hosted-client.ts'

export async function hostedContextItemClient(holder: string, suppliedOwner?: RecordWriteOwner) {
  const client = recordApiClient()
  const owner = suppliedOwner ?? (await contextItemOwner('context', holder, null))
  const destination = await recordWriteDestination(client, owner)
  return {
    upsert: (input: Parameters<NonNullable<typeof client.upsertContextItem>>[0]) =>
      client.upsertContextItem!(input, destination),
    remove: (id: string, input: { expectedRevision?: string }) =>
      client.deleteContextItem!(id, input, destination),
  }
}
