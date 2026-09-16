import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { createRecordClient } from '../../record-client.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()
const uuid = z.string().uuid()
const limit = z.number().int().min(1).max(100).default(20)
const filter = z.string().min(1).optional()

function recordClient(ctx: Context) {
  const baseUrl = process.env.HUB_RECORD_API_URL
  if (!baseUrl) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'HUB_RECORD_API_URL is required',
    })
  }
  return createRecordClient({
    baseUrl,
    headers: { cookie: ctx.cookie, authorization: ctx.authorization },
  })
}

export const recordRouter = t.router({
  whoami: t.procedure.query(({ ctx }) => recordClient(ctx).whoami()),
  runs: t.procedure
    .input(
      z.object({
        limit,
        cursor: z.string().optional(),
        project: filter,
        agent: filter,
        job: filter,
        status: filter,
      }),
    )
    .query(({ ctx, input }) => recordClient(ctx).runs(input)),
  run: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).run(input.id)),
  reviews: t.procedure
    .input(z.object({ limit, cursor: z.string().optional() }))
    .query(({ ctx, input }) => recordClient(ctx).reviews(input)),
  review: t.procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => recordClient(ctx).review(input.id)),
  projects: t.procedure.query(({ ctx }) => recordClient(ctx).projects()),
})
