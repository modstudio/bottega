import { TRPCError } from '@trpc/server'
import { createRecordClient } from './record-client.ts'
import type { Context } from './trpc/context.ts'

function publicRecordClient(_ctx: Context) {
  const baseUrl = process.env.HUB_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_API_URL is required',
    })
  }
  return createRecordClient({ baseUrl, headers: {} })
}

export const publicDocsTree = (ctx: Context) => publicRecordClient(ctx).publicDocs()
export const publicDoc = (ctx: Context, id: string) => publicRecordClient(ctx).publicDoc(id)
export const publicDocSearch = (ctx: Context, query: string) =>
  publicRecordClient(ctx).publicDocSearch(query)
