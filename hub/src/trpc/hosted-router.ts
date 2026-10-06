import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { hostedBoardRouter } from './routers/hosted-board.ts'
import { hostedContextRouter } from './routers/hosted-context.ts'
import { recordRouter } from './routers/record.ts'

const t = initTRPC.context<Context>().create()

export const hostedRouter = t.router({
  board: hostedBoardRouter,
  context: hostedContextRouter,
  record: recordRouter,
})

export type HostedRouter = typeof hostedRouter
