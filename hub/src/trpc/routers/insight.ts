import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { strip, view } from '../../serve.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const input = z.object({
  hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]),
  filters: z.object({
    agent: z.string().max(64),
    project: z.string().max(64),
  }),
})

type ViewData = Awaited<ReturnType<typeof view>>
type RatioData = Extract<ViewData, { perTask: unknown }>
type SpendData = Extract<ViewData, { numerators: unknown }>
type RoutingData = Extract<ViewData, { matrix: unknown }>

const insightView = <Name extends 'ratio' | 'spend' | 'routing'>(name: Name) =>
  t.procedure.input(input).query(async ({ input: value }) => ({
    ...strip(value.hours),
    view: name,
    data: await view(name, value.hours, value.filters) as Name extends 'ratio'
      ? RatioData : Name extends 'spend' ? SpendData : RoutingData,
  }))

export const insightRouter = t.router({
  routing: insightView('routing'),
  ratio: insightView('ratio'),
  spend: insightView('spend'),
})
