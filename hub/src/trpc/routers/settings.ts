import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { collectNow, sendTest, strip, view } from '../../serve.ts'
import { setReport } from '../../settings.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const reportPatch = z.object({
  enabled: z.boolean(),
  to: z.array(z.string()),
  subjectPrefix: z.string(),
  fromName: z.string(),
  fromAddress: z.string(),
  windowHours: z.number(),
  minMinutes: z.number(),
  testTo: z.string(),
  projects: z.array(z.string()),
})

type ViewData = Awaited<ReturnType<typeof view>>
type SettingsData = Extract<ViewData, { report: unknown }>

function badRequest(cause: unknown): never {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: cause instanceof Error ? cause.message : String(cause),
  })
}

export const settingsRouter = t.router({
  get: t.procedure
    .input(
      z.object({ hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]) }),
    )
    .query(async ({ input }) => ({
      ...strip(input.hours),
      view: 'settings' as const,
      data: (await view('settings', input.hours)) as SettingsData,
    })),
  save: t.procedure.input(reportPatch).mutation(({ input }) => {
    try {
      return { ok: true as const, report: setReport(input) }
    } catch (cause) {
      return badRequest(cause)
    }
  }),
  sendTest: t.procedure.mutation(async () => {
    try {
      return await sendTest()
    } catch (cause) {
      return badRequest(cause)
    }
  }),
  collect: t.procedure.mutation(async () => {
    try {
      const result = await collectNow()
      if (!result.ran) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `${result.heldBy ?? 'another process'} is collecting; try again`,
        })
      }
      return { ok: true as const, at: new Date().toISOString() }
    } catch (cause) {
      if (cause instanceof TRPCError) throw cause
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: String(cause) })
    }
  }),
})
