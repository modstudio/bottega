import { TRPCError } from '@trpc/server'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resolveRecordApiUrl } from '../../shared/record-api-url.ts'
import { createRecordClient } from './record-client.ts'

function publicRecordClient() {
  const baseUrl = resolveRecordApiUrl()
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `BOTTEGA_RECORD_API_URL is required\nconfigure the address with ${PLATFORM_SLUG} record use <address>`,
    })
  }
  return createRecordClient({ baseUrl, headers: {} })
}

export const publicDocsTree = () => publicRecordClient().publicDocs()
export const publicDoc = (id: string) => publicRecordClient().publicDoc(id)
export const publicDocSearch = (query: string) => publicRecordClient().publicDocSearch(query)
