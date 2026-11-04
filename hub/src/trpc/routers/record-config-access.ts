import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import type { Context } from '../context.ts'
import { email } from './record-inputs.ts'
import { recordClient } from './record-router-client.ts'

const t = initTRPC.context<Context>().create()
const emailInput = z.object({ email })

export const recordConfigAccessRouter = t.router({
  configAccess: t.procedure.query(({ ctx }) => recordClient(ctx).configAccess()),
  grantConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).grantConfigAccess(input.email)),
  withdrawConfigAccess: t.procedure
    .input(emailInput)
    .mutation(({ ctx, input }) => recordClient(ctx).withdrawConfigAccess(input.email)),
})
