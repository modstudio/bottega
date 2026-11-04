import { createRecordClient, requiredRecordApiUrl } from '../../record-client.ts'
import type { Context } from '../context.ts'

export function recordClient(ctx: Context) {
  return createRecordClient({
    baseUrl: requiredRecordApiUrl(),
    headers: { cookie: ctx.cookie, authorization: ctx.authorization },
  })
}
