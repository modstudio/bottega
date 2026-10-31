import { initTRPC } from '@trpc/server'
import { storedMachineNames } from '../../../../shared/machine-config.ts'
import { agents, jobs } from '../../orch.ts'
import { cachedOrchResponse } from '../../serve.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

export const catalogRouter = t.router({
  // These are code-declared projections. Availability and billing are live machine
  // state and belong on `bottega agent list`, not in the inspectable catalog.
  jobs: t.procedure.query(() => cachedOrchResponse('catalog:jobs', jobs)),
  agents: t.procedure.query(() => cachedOrchResponse('catalog:agents', agents)),
  machineNames: t.procedure.query(() => storedMachineNames()),
})
