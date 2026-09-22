import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { runDetail as orchRun, score as orchScore } from '../../orch.ts'
import { runListInput } from '../../run-list-input.ts'
import { cachedStrip, view } from '../../serve.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const delivery = z.enum(['none', 'partial', 'full'])
const quality = z.enum(['wrong', 'mixed', 'right'])
const fidelity = z.enum(['drifted', 'partial', 'faithful'])

export const runRouter = t.router({
  list: t.procedure.input(runListInput).query(async ({ input }) => ({
    ...(await cachedStrip(input.hours)),
    view: 'runs' as const,
    data: await view('runs', input.hours, {
      agent: input.agent,
      project: input.project,
      offset: input.offset,
      limit: input.limit,
      search: input.search,
    }),
  })),
  get: t.procedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
    try {
      return await orchRun(input.id)
    } catch (cause) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }),
  score: t.procedure
    .input(
      z.object({
        id: z.number().int().positive(),
        delivery,
        quality: quality.nullable(),
        fidelity: fidelity.nullable(),
        note: z.string().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const message = await orchScore(
          input.id,
          input.delivery,
          input.quality,
          input.fidelity,
          input.note,
        )
        return { ok: true as const, message }
      } catch (cause) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }),
})
