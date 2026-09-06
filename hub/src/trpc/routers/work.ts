import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { strip, view } from '../../serve.ts'
import type { Context } from '../context.ts'
import { taskRecord } from '../../task.ts'

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

export function createWorkRouter(deps: {
  strip: typeof strip
  view: typeof view
  taskRecord: typeof taskRecord
} = { strip, view, taskRecord }) {
  const taskView = (name: 'flight' | 'done') =>
    t.procedure.input(input).query(async ({ input: value }) => ({
      ...deps.strip(value.hours),
      view: name,
      data: await deps.view(name, value.hours, value.filters) as TaskData,
    }))
  return t.router({
  task: t.procedure.input(z.object({ key: z.string().min(1).max(64) })).query(({ input: value }) => {
    try {
      return deps.taskRecord(value.key)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.startsWith('no task ')) throw new TRPCError({ code: 'NOT_FOUND', message })
      throw cause
    }
  }),
  flight: taskView('flight'),
  board: t.procedure.input(input).query(async ({ input: value }) => ({
    ...deps.strip(value.hours),
    view: 'board' as const,
    data: await deps.view('board', value.hours, value.filters) as BoardData,
  })),
  done: taskView('done'),
  })
}

export const workRouter = createWorkRouter()
