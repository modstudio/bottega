import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { TASK_STATUSES } from '../../../../shared/trackers.ts'
import { strip, view } from '../../serve.ts'
import { commentTask, setTask, taskRecord } from '../../task.ts'
import { getTaskDocument, updateTaskDocument } from '../../task-document.ts'
import type { Context } from '../context.ts'

const t = initTRPC.context<Context>().create()

function asWriteError(cause: unknown, conflict?: { from: string; to: string }): TRPCError {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.startsWith('no task ')) {
    return new TRPCError({ code: 'NOT_FOUND', message, cause })
  }
  if (conflict) {
    return new TRPCError({
      code: 'CONFLICT',
      cause,
      message: `This document changed since you opened it (version ${conflict.from} → ${conflict.to}). Reload to see the current version; your edit was not saved.`,
    })
  }
  return new TRPCError({ code: 'BAD_REQUEST', message, cause })
}

async function write<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw asWriteError(cause)
  }
}

const input = z.object({
  hours: z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]),
  filters: z.object({
    agent: z.string().max(64),
    project: z.string().max(64),
    source: z.string().max(64),
  }),
})

const taskIdentityInput = {
  key: z.string().min(1).max(64),
  scope: z.object({
    project: z.string().min(1).max(64).optional(),
    recordId: z.string().min(1).max(128).optional(),
  }),
}

type ViewData = Awaited<ReturnType<typeof view>>
type TaskData = Extract<ViewData, { dropped: unknown }>
type BoardData = Extract<ViewData, { cards: unknown }>

type WorkDeps = {
  strip: typeof strip
  view: typeof view
  taskRecord: typeof taskRecord
  setTask: typeof setTask
  commentTask: typeof commentTask
  getTaskDocument: typeof getTaskDocument
  updateTaskDocument: typeof updateTaskDocument
}

export function createWorkRouter(given: Partial<WorkDeps> = {}) {
  const deps: WorkDeps = {
    strip,
    view,
    taskRecord,
    setTask,
    commentTask,
    getTaskDocument,
    updateTaskDocument,
    ...given,
  }
  const taskView = (name: 'flight' | 'done') =>
    t.procedure.input(input).query(async ({ input: value }) => ({
      ...deps.strip(value.hours),
      view: name,
      data: (await deps.view(name, value.hours, value.filters)) as TaskData,
    }))
  return t.router({
    task: t.procedure.input(z.object(taskIdentityInput)).query(({ input: value }) => {
      try {
        return deps.taskRecord(value.key, value.scope)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (message.startsWith('no task ')) throw new TRPCError({ code: 'NOT_FOUND', message })
        throw cause
      }
    }),
    setStatus: t.procedure
      .input(
        z.object({
          ...taskIdentityInput,
          status: z.enum(TASK_STATUSES),
        }),
      )
      .mutation(({ input: value }) =>
        write(() => deps.setTask(value.key, value.scope, { status: value.status })),
      ),
    setTitle: t.procedure
      .input(
        z.object({
          ...taskIdentityInput,
          title: z.string().trim().min(1).max(500),
        }),
      )
      .mutation(({ input: value }) =>
        write(() => deps.setTask(value.key, value.scope, { title: value.title })),
      ),
    comment: t.procedure
      .input(
        z.object({
          ...taskIdentityInput,
          body: z.string().trim().min(1),
        }),
      )
      .mutation(({ input: value }) =>
        write(() => deps.commentTask(value.key, value.scope, value.body)),
      ),
    setDocument: t.procedure
      .input(
        z.object({
          id: z.uuid(),
          title: z.string().trim().min(1).max(500),
          body: z.string(),
          version: z.string().min(1),
        }),
      )
      .mutation(async ({ input: value }) => {
        try {
          return await deps.updateTaskDocument(value.id, {
            title: value.title,
            body: value.body,
            expectedVersion: value.version,
          })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (message.includes(`changed since version ${value.version}`)) {
            let current: ReturnType<typeof deps.getTaskDocument>
            try {
              current = deps.getTaskDocument(value.id)
            } catch (lookupCause) {
              throw asWriteError(lookupCause)
            }
            throw asWriteError(cause, { from: value.version, to: current.version })
          }
          throw asWriteError(cause)
        }
      }),
    flight: taskView('flight'),
    board: t.procedure.input(input).query(async ({ input: value }) => ({
      ...deps.strip(value.hours),
      view: 'board' as const,
      data: (await deps.view('board', value.hours, value.filters)) as BoardData,
    })),
    done: taskView('done'),
  })
}

export const workRouter = createWorkRouter()
