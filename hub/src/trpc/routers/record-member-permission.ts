import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { memberPermission } from '../../record-client.ts'
import type { Context } from '../context.ts'
import { email } from './record-inputs.ts'
import { recordClient } from './record-router-client.ts'

const t = initTRPC.context<Context>().create()

export const recordMemberPermissionRouter = t.router({
  setMemberPermission: t.procedure
    .input(z.object({ email, permission: memberPermission }))
    .mutation(({ ctx, input }) =>
      recordClient(ctx).setMemberPermission(input.email, input.permission),
    ),
})
