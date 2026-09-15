import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { projectAdd, projectRemove, projectSet } from '../../orch.ts'
import { projects, trackerPresentation } from '../../projects.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

const settings = z.record(z.string(), z.unknown())
const addInput = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  stack: z.string().optional(),
  canon: z.boolean().optional(),
})
const setInput = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  stack: z.string().optional(),
  canon: z.boolean().optional(),
  settings: settings.optional(),
})
const removeInput = z.object({ name: z.string().min(1) })

type ProjectWrites = {
  add: typeof projectAdd
  set: typeof projectSet
  remove: typeof projectRemove
}

export function createProjectRouter(writes: ProjectWrites) {
  const badRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      })
    }
  }

  return t.router({
    list: t.procedure.query(() =>
      projects().map((project) => ({
        ...project,
        trackerStatus: trackerPresentation(project),
      })),
    ),
    add: t.procedure.input(addInput).mutation(({ input }) => badRequest(() => writes.add(input))),
    set: t.procedure.input(setInput).mutation(({ input }) => {
      const { name, ...body } = input
      return badRequest(() => writes.set(name, body))
    }),
    remove: t.procedure
      .input(removeInput)
      .mutation(({ input }) => badRequest(() => writes.remove(input.name))),
  })
}

export const projectRouter = createProjectRouter({
  add: projectAdd,
  set: projectSet,
  remove: projectRemove,
})
