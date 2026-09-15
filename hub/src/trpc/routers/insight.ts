import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { health } from '../../orch.ts'
import { cachedOrchResponse, cachedStrip, strip, view } from '../../serve.ts'
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
  t.procedure.input(input).query(async ({ input: value }) => {
    const load = async () => ({
      ...(name === 'routing' ? await cachedStrip(value.hours) : strip(value.hours)),
      view: name,
      data: (await view(name, value.hours, value.filters)) as Name extends 'ratio'
        ? RatioData
        : Name extends 'spend'
          ? SpendData
          : RoutingData,
    })
    return name === 'routing'
      ? cachedOrchResponse(
          `routing:${value.hours}:${value.filters.agent}:${value.filters.project}`,
          load,
        )
      : load()
  })

export const insightRouter = t.router({
  health: t.procedure.input(input).query(({ input: value }) => {
    const days = Math.max(1, Math.ceil(value.hours / 24))
    return cachedOrchResponse(`health:${days}`, async () => ({
      ...(await cachedStrip(value.hours)),
      view: 'health' as const,
      data: await health(days),
    }))
  }),
  routing: insightView('routing'),
  ratio: insightView('ratio'),
  spend: insightView('spend'),
})
