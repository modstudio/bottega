import { initTRPC } from '@trpc/server'
import type { Context } from '../context.ts'
import { agents, jobs } from '../../orch.ts'

const t = initTRPC.context<Context>().create()

export const catalogRouter = t.router({
  jobs: t.procedure.query(() => jobs()),
  agents: t.procedure.query(() => agents()),
})
