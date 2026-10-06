import { TRPCError } from '@trpc/server'
import { createRecordClient } from './record-client.ts'

function publicRecordClient() {
  const baseUrl = process.env.HUB_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_API_URL is required',
    })
  }
  return createRecordClient({ baseUrl, headers: {} })
}

export const publicDocsTree = () => publicRecordClient().publicDocs()
export const publicDoc = (id: string) => publicRecordClient().publicDoc(id)
export const publicDocSearch = (query: string) => publicRecordClient().publicDocSearch(query)
