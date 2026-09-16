import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { recordRouter } from './routers/record.ts'

const t = initTRPC.context<Context>().create()

export const hostedRouter = t.router({
  record: recordRouter,
})
