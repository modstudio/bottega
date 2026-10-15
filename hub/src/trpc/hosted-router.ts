import { initTRPC } from '@trpc/server'
import type { Context } from './context.ts'
import { docReorderProcedure } from './routers/doc.ts'
import { hostedBoardRouter } from './routers/hosted-board.ts'
import { hostedContextRouter } from './routers/hosted-context.ts'
import { publicDocsRouter } from './routers/public-docs.ts'
import { recordRouter } from './routers/record.ts'

const t = initTRPC.context<Context>().create()

export const hostedRouter = t.router({
  board: hostedBoardRouter,
  context: hostedContextRouter,
  record: recordRouter,
  publicDocs: publicDocsRouter,
  doc: t.router({ reorder: docReorderProcedure }),
})

export type HostedRouter = typeof hostedRouter
