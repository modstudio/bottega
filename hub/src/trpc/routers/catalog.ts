import { initTRPC } from '@trpc/server'
import { agents, jobs } from '../../orch.ts'
import { cachedOrchResponse } from '../../serve.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export const catalogRouter = t.router({
  // These are code-declared projections. Availability and billing are live machine
  // state and belong on `orch agents`, not in the inspectable catalog.
  jobs: t.procedure.query(() => cachedOrchResponse('catalog:jobs', jobs)),
  agents: t.procedure.query(() => cachedOrchResponse('catalog:agents', agents)),
})
