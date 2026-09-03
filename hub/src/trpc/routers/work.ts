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
type TaskData = Extract<ViewData, { dropped: unknown }>
type BoardData = Extract<ViewData, { cards: unknown }>

const taskView = (name: 'flight' | 'done') =>
  t.procedure.input(input).query(async ({ input: value }) => ({
    ...strip(value.hours),
    view: name,
    data: await view(name, value.hours, value.filters) as TaskData,
  }))

export const workRouter = t.router({
  flight: taskView('flight'),
  board: t.procedure.input(input).query(async ({ input: value }) => ({
    ...strip(value.hours),
    view: 'board' as const,
    data: await view('board', value.hours, value.filters) as BoardData,
  })),
  done: taskView('done'),
})
