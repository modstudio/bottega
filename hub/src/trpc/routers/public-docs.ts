import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { publicDoc, publicDocSearch, publicDocsTree } from '../../public-docs.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export const publicDocsRouter = t.router({
  tree: t.procedure.query(() => publicDocsTree()),
  get: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input }) => publicDoc(input.id)),
  search: t.procedure
    .input(z.object({ query: z.string() }))
    .query(({ input }) => publicDocSearch(input.query)),
})
