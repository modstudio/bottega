import { initTRPC } from '@trpc/server'
import type { Context } from '../context.ts'
import { agents, jobs } from '../../orch.ts'

const t = initTRPC.context<Context>().create()

export const catalogRouter = t.router({
  // These are code-declared projections. Availability and billing are live machine
  // state and belong on `orch agents`, not in the inspectable catalog.
  jobs: t.procedure.query(() => jobs()),
  agents: t.procedure.query(() => agents()),
})
