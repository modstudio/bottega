import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { publicDoc, publicDocSearch, publicDocsTree } from '../../public-docs.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export const publicDocsRouter = t.router({
  tree: t.procedure.query(({ ctx }) => publicDocsTree(ctx)),
  get: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => publicDoc(ctx, input.id)),
  search: t.procedure
    .input(z.object({ query: z.string() }))
    .query(({ ctx, input }) => publicDocSearch(ctx, input.query)),
})
